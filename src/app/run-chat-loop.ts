import { randomUUID } from "node:crypto";
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
  isSecurityRestrictedInvokeError,
  isToolAvailable,
  parseToolArgs,
} from "../domain/tool-call";
import type {
  ChatMessage,
  CompletionGateway,
  ConsoleIO,
  HookPhase,
  LoadedSession,
  OpenAIUsage,
  RuntimeConfig,
  SessionStateSnapshot,
  SlashCommand,
  ToolRuntime,
} from "../domain/types";
import {
  activateWorkflowGate,
  createWorkflowGate,
  recordWorkflowToolSuccess,
  resetWorkflowGate,
  shouldBlockToolExecution,
} from "../domain/workflow-gate";
import { buildHookContinuationMessage } from "../hooks/continuation-message";
import { createHookDispatcher, type HookDispatcher } from "../hooks/dispatcher";
import {
  createSessionFilePath,
  listSessionSummaries,
  loadSession,
  resolveSessionSelector,
} from "../session/store";
import {
  getAssistantContent,
  getToolCalls,
  requestAssistantMessage,
} from "./chat-orchestrator";

interface RunChatLoopDeps {
  config: RuntimeConfig;
  completionGateway: CompletionGateway;
  toolRuntime: ToolRuntime;
  io: ConsoleIO;
  resumeSelector?: string | null;
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
  "  /workflow Show/change chat workflow gate",
  "  /status Show current session status",
  "  /new    Start a new session",
  "  /resume Resume a saved session",
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
  sessionId: string;
  sessionPath: string;
  model: string;
  baseUrl: string;
  agentInstructionPath: string | null;
  configuredModelCount: number;
  messageCount: number;
  lastUsage: OpenAIUsage | null;
  cumulativeUsage: OpenAIUsage;
  tokenLimit: number | null;
  workflowGateEnabled: boolean;
  activeHooks: string[];
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
    workflowGateEnabled,
    activeHooks,
    toolRuntimeSecurity,
  } = params;
  const lines = [
    `session_id=${params.sessionId}`,
    `session_file=${params.sessionPath}`,
    `model=${model}`,
    `base_url=${baseUrl}`,
    `instruction_file=${agentInstructionPath ?? "N/A"}`,
    `configured_models=${configuredModelCount}`,
    `messages=${messageCount}`,
    `chat_workflow_gate=${workflowGateEnabled ? "on" : "off"}`,
    `hooks=${activeHooks.length > 0 ? activeHooks.join(",") : "none"}`,
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

function buildSessionStateSnapshot(params: {
  currentModel: string;
  workflowGateEnabled: boolean;
  lastUsage: OpenAIUsage | null;
  cumulativeUsage: OpenAIUsage;
}): SessionStateSnapshot {
  return {
    currentModel: params.currentModel,
    workflowGateEnabled: params.workflowGateEnabled,
    lastUsage: params.lastUsage,
    cumulativeUsage: params.cumulativeUsage,
  };
}

function createDefaultMessages(systemPrompt: string): ChatMessage[] {
  return [{ role: "system", content: systemPrompt }];
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
  resumeSelector = null,
  onExit,
}: RunChatLoopDeps): Promise<void> {
  const tools = toolRuntime.getAllowedTools();
  const availableToolNames = toolRuntime.getAllowedToolNames();
  const availableToolSet = new Set(availableToolNames);
  const workflowGate = createWorkflowGate({
    activated: false,
    availableToolNames,
  });
  let sessionId: string = randomUUID();
  let sessionPath = createSessionFilePath({
    workspaceRoot: config.workspaceRoot,
    sessionId,
  });
  let currentPhase: HookPhase | undefined;
  const createDispatcher = () =>
    createHookDispatcher({
      config,
      mode: "chat",
      workflowGate,
      getSessionId: () => sessionId,
      getSessionPath: () => sessionPath,
      logger: io,
    });
  let hookDispatcher: HookDispatcher = await createDispatcher();

  let messages: ChatMessage[] = createDefaultMessages(config.systemPrompt);
  let currentModel = config.model;
  let currentBaseUrl = config.baseUrl;
  let currentApiKey = config.apiKey;
  let lastUsage: OpenAIUsage | null = null;
  let cumulativeUsage = createZeroUsage();
  let chatWorkflowGateEnabled = config.chatWorkflowGateEnabled;
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

  const getSessionStateSnapshot = (): SessionStateSnapshot =>
    buildSessionStateSnapshot({
      currentModel,
      workflowGateEnabled: chatWorkflowGateEnabled,
      lastUsage,
      cumulativeUsage,
    });

  const appendSessionStateChanged = async () => {
    await hookDispatcher.dispatch({
      name: "session.state.changed",
      phase: currentPhase,
      payload: {
        state: getSessionStateSnapshot(),
      },
    });
  };

  const loadSavedSession = async (
    selector: string | null,
  ): Promise<LoadedSession> => {
    if (selector) {
      return loadSession(
        resolveSessionSelector({
          workspaceRoot: config.workspaceRoot,
          selector,
        }),
      );
    }

    const summaries = listSessionSummaries(config.workspaceRoot);
    if (summaries.length === 0) {
      throw new Error("no saved sessions found");
    }

    const selectedPath = await io.selectSession(summaries, sessionId);
    return loadSession(selectedPath);
  };

  const applyLoadedSession = (loaded: LoadedSession) => {
    messages =
      loaded.messages.length > 0
        ? loaded.messages
        : createDefaultMessages(config.systemPrompt);
    sessionId = loaded.sessionId;
    sessionPath = loaded.path;
    currentModel = loaded.state.currentModel;
    if (
      !configuredModelNames.includes(currentModel) &&
      currentModel !== config.model
    ) {
      io.writeStatus(
        `[session] saved model "${currentModel}" is unavailable; falling back to ${config.model}`,
      );
      currentModel = config.model;
    }
    currentBaseUrl = resolveBaseUrl(currentModel);
    currentApiKey = resolveApiKey(currentModel);
    lastUsage = loaded.state.lastUsage;
    cumulativeUsage = loaded.state.cumulativeUsage;
    chatWorkflowGateEnabled = loaded.state.workflowGateEnabled;
    resetWorkflowGate(workflowGate);
  };

  const reinitializeHookDispatcher = async () => {
    await hookDispatcher.dispose();
    hookDispatcher = await createDispatcher();
  };

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

  const enterPhase = async (
    phase: HookPhase,
    payload?: Record<string, unknown>,
  ) => {
    currentPhase = phase;
    await hookDispatcher.dispatch({
      name: "phase.entered",
      phase,
      payload,
    });
  };
  const appendUserMessage = async (content: string) => {
    messages = withUserMessage(messages, content);
    await hookDispatcher.dispatch({
      name: "message.appended",
      phase: currentPhase,
      payload: {
        message: messages.at(-1),
      },
    });
  };
  const appendAssistantFinal = async (content: string) => {
    messages = withAssistantFinalMessage(messages, content);
    await hookDispatcher.dispatch({
      name: "message.appended",
      phase: currentPhase,
      payload: {
        message: messages.at(-1),
      },
    });
  };
  const appendAssistantToolCallMessage = async (
    content: string,
    toolCalls: ReturnType<typeof getToolCalls>,
  ) => {
    messages = withAssistantToolCalls(messages, content, toolCalls);
    await hookDispatcher.dispatch({
      name: "message.appended",
      phase: currentPhase,
      payload: {
        message: messages.at(-1),
      },
    });
  };
  const appendToolMessage = async (toolCallId: string, content: unknown) => {
    messages = withToolResult(messages, toolCallId, content);
    await hookDispatcher.dispatch({
      name: "message.appended",
      phase: currentPhase,
      payload: {
        message: messages.at(-1),
      },
    });
  };

  if (resumeSelector !== null) {
    const loaded = await loadSavedSession(resumeSelector);
    applyLoadedSession(loaded);
    await reinitializeHookDispatcher();
    io.resetSessionUiState();
    io.updateTokenStatus({
      model: currentModel,
      baseUrl: currentBaseUrl,
      lastUsage,
      cumulativeUsage,
      tokenLimit: resolveTokenLimit(currentModel),
    });
    await hookDispatcher.dispatch({
      name: "session.loaded",
      payload: {
        sessionId,
        sessionPath,
        state: getSessionStateSnapshot(),
      },
    });
  }

  await hookDispatcher.dispatch({
    name: "run.started",
    payload: { model: currentModel },
  });
  if (resumeSelector === null) {
    await hookDispatcher.dispatch({
      name: "session.started",
      payload: {
        sessionId,
        sessionPath,
        state: getSessionStateSnapshot(),
        message: messages[0],
      },
    });
  }

  try {
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
                sessionId,
                sessionPath,
                model: currentModel,
                baseUrl: currentBaseUrl,
                agentInstructionPath: config.agentInstructionPath,
                configuredModelCount: configuredModelNames.length,
                messageCount: messages.length,
                lastUsage,
                cumulativeUsage,
                tokenLimit: resolveTokenLimit(currentModel),
                workflowGateEnabled: chatWorkflowGateEnabled,
                activeHooks: config.hooks.map((hook) => hook.hookName),
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
              void appendSessionStateChanged();
            },
          },
          {
            name: "workflow",
            description: "Show/change chat workflow gate",
            callback: (args) => {
              consumedSlashCommand = true;
              const action = args[0]?.toLowerCase() ?? "status";

              if (action === "status") {
                io.writeStatus(
                  `chat workflow gate is ${chatWorkflowGateEnabled ? "on" : "off"}`,
                );
                return;
              }

              if (action === "on") {
                chatWorkflowGateEnabled = true;
                io.writeStatus("chat workflow gate enabled");
                void appendSessionStateChanged();
                return;
              }

              if (action === "off") {
                chatWorkflowGateEnabled = false;
                io.writeStatus("chat workflow gate disabled");
                void appendSessionStateChanged();
                return;
              }

              if (action === "toggle") {
                chatWorkflowGateEnabled = !chatWorkflowGateEnabled;
                io.writeStatus(
                  `chat workflow gate ${chatWorkflowGateEnabled ? "enabled" : "disabled"}`,
                );
                void appendSessionStateChanged();
                return;
              }

              io.writeError("[error] usage: /workflow [status|on|off|toggle]");
            },
          },
          {
            name: "new",
            description: "Start a new session",
            callback: () => {
              consumedSlashCommand = true;
              messages = createDefaultMessages(config.systemPrompt);
              lastUsage = null;
              cumulativeUsage = createZeroUsage();
              chatWorkflowGateEnabled = config.chatWorkflowGateEnabled;
              sessionId = randomUUID();
              sessionPath = createSessionFilePath({
                workspaceRoot: config.workspaceRoot,
                sessionId,
              });
              resetWorkflowGate(workflowGate);
              io.resetSessionUiState();
              io.updateTokenStatus({
                model: currentModel,
                baseUrl: currentBaseUrl,
                lastUsage,
                cumulativeUsage,
                tokenLimit: resolveTokenLimit(currentModel),
              });
              io.writeStatus("started a new session");
              void hookDispatcher.dispatch({
                name: "session.reset",
                payload: {},
              });
              void hookDispatcher.dispatch({
                name: "session.started",
                payload: {
                  sessionId,
                  sessionPath,
                  state: getSessionStateSnapshot(),
                  message: messages[0],
                },
              });
            },
          },
          {
            name: "resume",
            description: "Resume a saved session",
            callback: async (args) => {
              consumedSlashCommand = true;
              const selector = args.join(" ").trim() || null;
              try {
                const loaded = await loadSavedSession(selector);
                applyLoadedSession(loaded);
                await reinitializeHookDispatcher();
                io.resetSessionUiState();
                io.updateTokenStatus({
                  model: currentModel,
                  baseUrl: currentBaseUrl,
                  lastUsage,
                  cumulativeUsage,
                  tokenLimit: resolveTokenLimit(currentModel),
                });
                io.writeStatus(`resumed session ${sessionId}`);
                await hookDispatcher.dispatch({
                  name: "session.loaded",
                  payload: {
                    sessionId,
                    sessionPath,
                    state: getSessionStateSnapshot(),
                  },
                });
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                io.writeError(`[error] ${message}`);
              }
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
        await hookDispatcher.dispatch({
          name: "slash.executed",
          phase: currentPhase,
          payload: {
            command: userInput.slice(1).split(/\s+/)[0] ?? "",
            rawInput: userInput,
          },
        });
        if (shouldExit) {
          await hookDispatcher.dispatch({
            name: "run.completed",
            payload: { reason: "exit" },
          });
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
        await enterPhase("analyze");
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

        await appendUserMessage(
          buildMessageWithMentionAttachments(userInput, mentionAttachments),
        );

        let printedFinal = false;

        for (let round = 0; round < config.maxToolRounds; round++) {
          io.writeStatus(
            `thinking... (round ${round + 1}/${config.maxToolRounds})`,
          );
          await enterPhase("analyze", { round: round + 1 });
          await hookDispatcher.dispatch({
            name: "model.requested",
            phase: currentPhase,
            payload: {
              round: round + 1,
              model: currentModel,
            },
          });

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
          await hookDispatcher.dispatch({
            name: "model.responded",
            phase: currentPhase,
            payload: {
              round: round + 1,
              hasMessage: assistantMessage !== null,
              retriedWithRequired,
              toolCallCount: assistantMessage
                ? getToolCalls(assistantMessage).length
                : 0,
            },
          });

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
            await appendSessionStateChanged();
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
            await appendAssistantFinal(assistantText);
            await enterPhase("verify", { round: round + 1 });
            const verifyDispatch = await hookDispatcher.dispatch({
              name: "phase.check",
              phase: "verify",
              payload: { round: round + 1 },
            });
            if (verifyDispatch.decision) {
              io.writeStatus("hook gate blocked verify phase");
              await appendUserMessage(
                buildHookContinuationMessage(verifyDispatch.decision),
              );
              continue;
            }

            await enterPhase("done", { round: round + 1 });
            const doneDispatch = await hookDispatcher.dispatch({
              name: "phase.check",
              phase: "done",
              payload: { round: round + 1 },
            });
            if (doneDispatch.decision) {
              io.writeStatus("hook gate blocked final response");
              await appendUserMessage(
                buildHookContinuationMessage(doneDispatch.decision),
              );
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

          if (chatWorkflowGateEnabled) {
            activateWorkflowGate(workflowGate);
          }
          await enterPhase("execute", { round: round + 1 });
          await appendAssistantToolCallMessage(
            getAssistantContent(assistantMessage),
            toolCalls,
          );

          for (const toolCall of toolCalls) {
            if (toolCall.type !== "function") {
              continue;
            }

            const toolName = toolCall.function.name;
            await hookDispatcher.dispatch({
              name: "tool.call.started",
              phase: currentPhase,
              payload: {
                toolName,
                toolCallId: toolCall.id,
              },
            });

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
              await appendToolMessage(toolCall.id, failure);
              io.writeError(`invalid arguments JSON: ${parsedArgs.error}`);
              await hookDispatcher.dispatch({
                name: "tool.call.completed",
                phase: currentPhase,
                payload: {
                  toolName,
                  toolCallId: toolCall.id,
                  status: "invalid",
                },
              });
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
              await appendToolMessage(toolCall.id, failure);
              io.writeError(unavailableMessage);
              await hookDispatcher.dispatch({
                name: "tool.call.completed",
                phase: currentPhase,
                payload: {
                  toolName,
                  toolCallId: toolCall.id,
                  status: "unavailable",
                },
              });
              continue;
            }

            try {
              const preflightFailure = shouldBlockToolExecution(
                workflowGate,
                toolName,
              );
              if (preflightFailure) {
                await appendToolMessage(toolCall.id, preflightFailure);
                io.writeError(
                  `workflow gate for ${toolName}: ${preflightFailure.message}`,
                );
                await hookDispatcher.dispatch({
                  name: "tool.call.completed",
                  phase: currentPhase,
                  payload: {
                    toolName,
                    toolCallId: toolCall.id,
                    status: "blocked",
                  },
                });
                continue;
              }

              const result = await io.runWithSpinner(
                `[tool] running ${toolName}`,
                () => toolRuntime.invoke(toolName, parsedArgs.value),
              );
              await appendToolMessage(toolCall.id, result);
              io.writeStatus(`response from ${toolName}`);
              io.writeOutput(toPreview(result, config.maxPreviewChars));
              await hookDispatcher.dispatch({
                name: "tool.call.completed",
                phase: currentPhase,
                payload: {
                  toolName,
                  toolCallId: toolCall.id,
                  status: "success",
                },
              });
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
                    await appendToolMessage(toolCall.id, bypassedResult);
                    io.writeStatus(`response from ${toolName}`);
                    io.writeOutput(
                      toPreview(bypassedResult, config.maxPreviewChars),
                    );
                    await hookDispatcher.dispatch({
                      name: "tool.call.completed",
                      phase: currentPhase,
                      payload: {
                        toolName,
                        toolCallId: toolCall.id,
                        status: "success",
                        securityBypass: true,
                      },
                    });
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
              await appendToolMessage(toolCall.id, failure);
              io.writeError(`error from ${toolName}: ${invokeError}`);
              await hookDispatcher.dispatch({
                name: "tool.call.completed",
                phase: currentPhase,
                payload: {
                  toolName,
                  toolCallId: toolCall.id,
                  status:
                    failureReason === "security_bypass_declined"
                      ? "blocked"
                      : "error",
                },
              });
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
  } catch (error) {
    await hookDispatcher.dispatch({
      name: "run.failed",
      phase: currentPhase,
      payload: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    await hookDispatcher.dispose();
  }
}
