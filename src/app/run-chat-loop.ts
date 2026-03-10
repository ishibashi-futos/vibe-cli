import {
  withAssistantFinalMessage,
  withAssistantToolCalls,
  withToolResult,
  withUserMessage,
} from "../domain/message-state";
import { toPreview } from "../domain/policies";
import {
  buildSecurityBypassDeclinedMessage,
  buildToolFailure,
  buildToolUnavailableMessage,
  isToolAvailable,
  isSecurityRestrictedInvokeError,
  parseToolArgs,
} from "../domain/tool-call";
import type {
  ChatMessage,
  CompletionGateway,
  ConsoleIO,
  OpenAIUsage,
  RuntimeConfig,
  SlashCommand,
  ToolRuntime,
} from "../domain/types";
import {
  getAssistantContent,
  getToolCalls,
  requestAssistantMessage,
} from "./chat-orchestrator";
import {
  activateWorkflowGate,
  buildWorkflowFinalContinuationMessage,
  createWorkflowGate,
  recordWorkflowToolSuccess,
  shouldBlockToolExecution,
} from "../domain/workflow-gate";

interface RunChatLoopDeps {
  config: RuntimeConfig;
  completionGateway: CompletionGateway;
  toolRuntime: ToolRuntime;
  io: ConsoleIO;
  onExit?: () => void;
}

interface MentionAttachment {
  path: string;
  content: string;
  truncated: boolean;
  error: string | null;
}

const HELP_LINES = [
  "Available slash commands:",
  "  /help   Show help",
  "  /model  Show/change model",
  "  /status Show current session status",
  "  /new    Start a new session",
  "  /exit   Exit",
  "  /quit   Exit (alias)",
];

function createZeroUsage(): OpenAIUsage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
}

function addUsage(base: OpenAIUsage, delta: OpenAIUsage | null): OpenAIUsage {
  if (!delta) {
    return base;
  }

  return {
    prompt_tokens: base.prompt_tokens + delta.prompt_tokens,
    completion_tokens: base.completion_tokens + delta.completion_tokens,
    total_tokens: base.total_tokens + delta.total_tokens,
  };
}

function formatStatus(params: {
  model: string;
  baseUrl: string;
  agentInstructionPath: string | null;
  configuredModelCount: number;
  messageCount: number;
  lastUsage: OpenAIUsage | null;
  cumulativeUsage: OpenAIUsage;
  tokenLimit: number | null;
  toolRuntimeSecurity: {
    writeScope: "read-only" | "workspace-write" | "unrestricted";
    defaultPolicy: "allow" | "deny";
    explicitDenyTools: string[];
  } | null;
}): string[] {
  const {
    model,
    baseUrl,
    agentInstructionPath,
    configuredModelCount,
    messageCount,
    lastUsage,
    cumulativeUsage,
    tokenLimit,
    toolRuntimeSecurity,
  } = params;
  const lines = [
    `model=${model}`,
    `base_url=${baseUrl}`,
    `instruction_file=${agentInstructionPath ?? "N/A"}`,
    `configured_models=${configuredModelCount}`,
    `messages=${messageCount}`,
    `tokens(last) prompt=${lastUsage?.prompt_tokens ?? "N/A"} completion=${lastUsage?.completion_tokens ?? "N/A"} total=${lastUsage?.total_tokens ?? "N/A"}`,
    `tokens(total) prompt=${cumulativeUsage.prompt_tokens} completion=${cumulativeUsage.completion_tokens} total=${cumulativeUsage.total_tokens}`,
  ];

  if (toolRuntimeSecurity) {
    lines.push(`write_scope=${toolRuntimeSecurity.writeScope}`);
    lines.push(`default_policy=${toolRuntimeSecurity.defaultPolicy}`);
    lines.push(
      `explicit_deny_tools=${toolRuntimeSecurity.explicitDenyTools.length > 0 ? toolRuntimeSecurity.explicitDenyTools.join(",") : "none"}`,
    );
  }

  if (typeof tokenLimit === "number") {
    const ratio = ((cumulativeUsage.total_tokens / tokenLimit) * 100).toFixed(
      1,
    );
    lines.push(`token_limit=${tokenLimit} (${ratio}%)`);
  }

  return lines;
}

function isReadFileOutput(value: Record<string, unknown>): value is {
  path: string;
  content: string;
  truncated: boolean;
} {
  return (
    typeof value.path === "string" &&
    typeof value.content === "string" &&
    typeof value.truncated === "boolean"
  );
}

function buildMessageWithMentionAttachments(
  userInput: string,
  attachments: MentionAttachment[],
): string {
  if (attachments.length === 0) {
    return userInput;
  }

  const sections = attachments.map((attachment) => {
    if (attachment.error) {
      return [
        `@${attachment.path}`,
        `[mention-error] ${attachment.error}`,
      ].join("\n");
    }

    const truncateNotice = attachment.truncated
      ? "[mention-note] truncated to configured max lines"
      : "[mention-note] full content for configured max lines window";

    return [
      `@${attachment.path}`,
      truncateNotice,
      "```text",
      attachment.content,
      "```",
    ].join("\n");
  });

  return [
    userInput,
    "",
    "[mentioned_files]",
    ...sections,
    "[/mentioned_files]",
  ].join("\n");
}

export async function runChatLoop({
  config,
  completionGateway,
  toolRuntime,
  io,
  onExit,
}: RunChatLoopDeps): Promise<void> {
  const tools = toolRuntime.getAllowedTools();
  const availableToolNames = toolRuntime.getAllowedToolNames();
  const availableToolSet = new Set(availableToolNames);

  let messages: ChatMessage[] = [
    { role: "system", content: config.systemPrompt },
  ];
  let currentModel = config.model;
  let currentBaseUrl = config.baseUrl;
  let currentApiKey = config.apiKey;
  let lastUsage: OpenAIUsage | null = null;
  let cumulativeUsage = createZeroUsage();
  const configuredModelNames = Array.from(
    new Set([
      ...Object.keys(config.modelContextLengths),
      ...Object.keys(config.modelBaseUrls),
      ...Object.keys(config.modelApiKeys),
    ]),
  ).sort();
  const resolveTokenLimit = (model: string): number | null =>
    config.modelContextLengths[model] ?? null;
  const resolveBaseUrl = (model: string): string =>
    config.modelBaseUrls[model] ?? config.baseUrl;
  const resolveApiKey = (model: string): string =>
    config.modelApiKeys[model] ?? config.apiKey;

  currentBaseUrl = resolveBaseUrl(currentModel);
  currentApiKey = resolveApiKey(currentModel);

  io.updateTokenStatus({
    model: currentModel,
    baseUrl: currentBaseUrl,
    lastUsage,
    cumulativeUsage,
    tokenLimit: resolveTokenLimit(currentModel),
  });

  io.writeStatus(`Chat loop started. model=${currentModel}`);
  io.writeStatus("Type /exit to quit.");
  io.writeStatus(
    "Submit with Cmd+Enter (macOS) or Ctrl+Enter (Windows/Linux).",
  );

  while (true) {
    let consumedSlashCommand = false;
    let shouldExit = false;
    const inputResult = await io.readUserInput("> ", {
      commands: [
        {
          name: "help",
          description: "Show slash command help",
          callback: () => {
            consumedSlashCommand = true;
            for (const line of HELP_LINES) {
              io.writeStatus(line);
            }
          },
        },
        {
          name: "status",
          description: "Show current session status",
          callback: () => {
            consumedSlashCommand = true;
            const statusLines = formatStatus({
              model: currentModel,
              baseUrl: currentBaseUrl,
              agentInstructionPath: config.agentInstructionPath,
              configuredModelCount: configuredModelNames.length,
              messageCount: messages.length,
              lastUsage,
              cumulativeUsage,
              tokenLimit: resolveTokenLimit(currentModel),
              toolRuntimeSecurity: toolRuntime.getSecuritySummary?.() ?? null,
            });
            for (const line of statusLines) {
              io.writeStatus(line);
            }
          },
        },
        {
          name: "model",
          description: "Show/change current model",
          callback: async () => {
            consumedSlashCommand = true;
            if (configuredModelNames.length === 0) {
              io.writeError(
                "[error] no models found in .agents/vibe-config.json",
              );
              return;
            }

            const selectableModels = [
              currentModel,
              ...configuredModelNames
                .filter((modelName) => modelName !== currentModel)
                .sort(),
            ];
            const requested = await io.selectModel(
              selectableModels,
              currentModel,
            );

            currentModel = requested;
            currentBaseUrl = resolveBaseUrl(currentModel);
            currentApiKey = resolveApiKey(currentModel);
            lastUsage = null;
            cumulativeUsage = createZeroUsage();
            io.updateTokenStatus({
              model: currentModel,
              baseUrl: currentBaseUrl,
              lastUsage,
              cumulativeUsage,
              tokenLimit: resolveTokenLimit(currentModel),
            });
            io.writeStatus(
              `switched model to ${currentModel} (base_url=${currentBaseUrl})`,
            );
          },
        },
        {
          name: "new",
          description: "Start a new session",
          callback: () => {
            consumedSlashCommand = true;
            messages = [{ role: "system", content: config.systemPrompt }];
            lastUsage = null;
            cumulativeUsage = createZeroUsage();
            io.resetSessionUiState();
            io.updateTokenStatus({
              model: currentModel,
              baseUrl: currentBaseUrl,
              lastUsage,
              cumulativeUsage,
              tokenLimit: resolveTokenLimit(currentModel),
            });
            io.writeStatus("started a new session");
          },
        },
        {
          name: "exit",
          description: "Exit the app",
          callback: () => {
            consumedSlashCommand = true;
            shouldExit = true;
            io.writeStatus("See you again!");
          },
        },
        {
          name: "quit",
          description: "Exit the app (alias)",
          callback: () => {
            consumedSlashCommand = true;
            shouldExit = true;
            io.writeStatus("See you again!");
          },
        },
      ] satisfies SlashCommand[],
    });
    const userInput = inputResult.value.trim();

    if (!userInput) {
      continue;
    }

    if (consumedSlashCommand) {
      if (shouldExit) {
        onExit?.();
        return;
      }
      continue;
    }

    if (userInput.startsWith("/")) {
      io.writeError("[error] unknown slash command");
      continue;
    }

    try {
      const mentionAttachments: MentionAttachment[] = [];
      for (const path of inputResult.mentionedPaths) {
        try {
          const readResult = await io.runWithSpinner(
            `[mention] reading ${path}`,
            () =>
              toolRuntime.invoke("read_file", {
                path,
                start_line: 1,
                max_lines: config.mentionMaxLines,
              }),
          );

          if (!isReadFileOutput(readResult)) {
            mentionAttachments.push({
              path,
              content: "",
              truncated: false,
              error: "read_file returned unexpected payload",
            });
            continue;
          }

          mentionAttachments.push({
            path: readResult.path,
            content: readResult.content,
            truncated: readResult.truncated,
            error: null,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          mentionAttachments.push({
            path,
            content: "",
            truncated: false,
            error: message,
          });
        }
      }

      messages = withUserMessage(
        messages,
        buildMessageWithMentionAttachments(userInput, mentionAttachments),
      );
      const workflowGate = createWorkflowGate({
        activated: false,
        availableToolNames,
      });

      let printedFinal = false;

      for (let round = 0; round < config.maxToolRounds; round++) {
        io.writeStatus(
          `thinking... (round ${round + 1}/${config.maxToolRounds})`,
        );

        const {
          message: assistantMessage,
          retriedWithRequired,
          usage,
        } = await io.runWithSpinner(
          `[model] waiting (round ${round + 1}/${config.maxToolRounds})`,
          () =>
            requestAssistantMessage({
              gateway: completionGateway,
              baseUrl: currentBaseUrl,
              apiKey: currentApiKey,
              model: currentModel,
              messages,
              tools,
              round,
              enforceToolCallFirstRound: config.enforceToolCallFirstRound,
            }),
        );

        if (usage) {
          lastUsage = usage;
          cumulativeUsage = addUsage(cumulativeUsage, usage);
          io.updateTokenStatus({
            model: currentModel,
            baseUrl: currentBaseUrl,
            lastUsage,
            cumulativeUsage,
            tokenLimit: resolveTokenLimit(currentModel),
          });
        }

        if (retriedWithRequired) {
          io.writeStatus(
            "no tool call in round 1, retrying with tool_choice=required",
          );
        }

        if (!assistantMessage) {
          io.writeStatus("assistant returned empty response");
          printedFinal = true;
          break;
        }

        const toolCalls = getToolCalls(assistantMessage);

        if (toolCalls.length === 0) {
          const assistantText = getAssistantContent(assistantMessage);
          messages = withAssistantFinalMessage(messages, assistantText);

          const continueMessage =
            buildWorkflowFinalContinuationMessage(workflowGate);
          if (continueMessage) {
            io.writeStatus("workflow gate blocked final response");
            messages = withUserMessage(messages, continueMessage);
            continue;
          }

          if (!assistantText) {
            io.writeStatus("assistant returned empty response");
          } else {
            io.writeOutput("");
            io.writeOutput(assistantText);
            io.writeOutput("");
          }

          printedFinal = true;
          break;
        }

        activateWorkflowGate(workflowGate);
        messages = withAssistantToolCalls(
          messages,
          getAssistantContent(assistantMessage),
          toolCalls,
        );

        for (const toolCall of toolCalls) {
          if (toolCall.type !== "function") {
            continue;
          }

          const toolName = toolCall.function.name;

          io.writeToolCall(toolName);
          io.writeOutput(
            toPreview(toolCall.function.arguments, config.maxPreviewChars),
          );

          const parsedArgs = parseToolArgs(toolCall.function.arguments);
          if (!parsedArgs.ok) {
            const failure = buildToolFailure(
              "invalid_arguments_json",
              parsedArgs.error,
            );
            messages = withToolResult(messages, toolCall.id, failure);
            io.writeError(`invalid arguments JSON: ${parsedArgs.error}`);
            continue;
          }

          if (!isToolAvailable(toolName, availableToolSet)) {
            const unavailableMessage = buildToolUnavailableMessage(
              toolName,
              availableToolNames,
            );
            const failure = buildToolFailure(
              "tool_not_available",
              unavailableMessage,
            );
            messages = withToolResult(messages, toolCall.id, failure);
            io.writeError(unavailableMessage);
            continue;
          }

          try {
            const preflightFailure = shouldBlockToolExecution(
              workflowGate,
              toolName,
            );
            if (preflightFailure) {
              messages = withToolResult(
                messages,
                toolCall.id,
                preflightFailure,
              );
              io.writeError(
                `workflow gate for ${toolName}: ${preflightFailure.message}`,
              );
              continue;
            }

            const result = await io.runWithSpinner(
              `[tool] running ${toolName}`,
              () => toolRuntime.invoke(toolName, parsedArgs.value),
            );
            messages = withToolResult(messages, toolCall.id, result);
            io.writeStatus(`response from ${toolName}`);
            io.writeOutput(toPreview(result, config.maxPreviewChars));
            if (
              typeof result === "object" &&
              result !== null &&
              "status" in result &&
              result.status === "success" &&
              "data" in result &&
              typeof result.data === "object" &&
              result.data !== null
            ) {
              recordWorkflowToolSuccess(
                workflowGate,
                toolName,
                result.data as Record<string, unknown>,
              );
            }
          } catch (error) {
            let failureReason:
              | "tool_invoke_error"
              | "security_bypass_declined" = "tool_invoke_error";
            let invokeError =
              error instanceof Error ? error.message : String(error);

            if (isSecurityRestrictedInvokeError(error)) {
              const shouldBypass = await io.selectSecurityBypass(
                toolName,
                invokeError,
              );

              if (shouldBypass) {
                io.writeStatus(`retrying ${toolName} with SecurityBypass`);
                try {
                  const bypassedResult = await io.runWithSpinner(
                    `[tool] running ${toolName} (SecurityBypass)`,
                    () =>
                      toolRuntime.invoke(toolName, parsedArgs.value, {
                        securityBypass: true,
                      }),
                  );
                  messages = withToolResult(
                    messages,
                    toolCall.id,
                    bypassedResult,
                  );
                  io.writeStatus(`response from ${toolName}`);
                  io.writeOutput(
                    toPreview(bypassedResult, config.maxPreviewChars),
                  );
                  if (
                    typeof bypassedResult === "object" &&
                    bypassedResult !== null &&
                    "status" in bypassedResult &&
                    bypassedResult.status === "success" &&
                    "data" in bypassedResult &&
                    typeof bypassedResult.data === "object" &&
                    bypassedResult.data !== null
                  ) {
                    recordWorkflowToolSuccess(
                      workflowGate,
                      toolName,
                      bypassedResult.data as Record<string, unknown>,
                    );
                  }
                  continue;
                } catch (retryError) {
                  invokeError =
                    retryError instanceof Error
                      ? retryError.message
                      : String(retryError);
                }
              } else {
                failureReason = "security_bypass_declined";
                invokeError = buildSecurityBypassDeclinedMessage(toolName);
              }
            }

            const failure = buildToolFailure(failureReason, invokeError);
            messages = withToolResult(messages, toolCall.id, failure);
            io.writeError(`error from ${toolName}: ${invokeError}`);
          }
        }
      }

      if (!printedFinal) {
        io.writeStatus(
          `tool loop reached max rounds (${config.maxToolRounds}).`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.writeError(`Request failed: ${message}`);
    }
  }
}
