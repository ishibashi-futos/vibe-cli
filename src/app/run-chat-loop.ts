import {
  withAssistantFinalMessage,
  withAssistantToolCalls,
  withToolResult,
  withUserMessage,
} from "../domain/message-state";
import { toPreview } from "../domain/policies";
import {
  buildToolFailure,
  buildToolUnavailableMessage,
  isToolAvailable,
  parseToolArgs,
} from "../domain/tool-call";
import type {
  ChatMessage,
  CompletionGateway,
  ConsoleIO,
  OpenAIUsage,
  RuntimeConfig,
  ToolRuntime,
} from "../domain/types";
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

function parseSlashCommand(
  input: string,
): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const tokens = trimmed
    .slice(1)
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }

  const [name, ...args] = tokens;
  return {
    name: name!.toLowerCase(),
    args,
  };
}

function formatStatus(params: {
  model: string;
  baseUrl: string;
  configuredModelCount: number;
  messageCount: number;
  lastUsage: OpenAIUsage | null;
  cumulativeUsage: OpenAIUsage;
  tokenLimit: number | null;
}): string[] {
  const {
    model,
    baseUrl,
    configuredModelCount,
    messageCount,
    lastUsage,
    cumulativeUsage,
    tokenLimit,
  } = params;
  const lines = [
    `[status] model=${model}`,
    `[status] base_url=${baseUrl}`,
    `[status] configured_models=${configuredModelCount}`,
    `[status] messages=${messageCount}`,
    `[status] tokens(last) prompt=${lastUsage?.prompt_tokens ?? "N/A"} completion=${lastUsage?.completion_tokens ?? "N/A"} total=${lastUsage?.total_tokens ?? "N/A"}`,
    `[status] tokens(total) prompt=${cumulativeUsage.prompt_tokens} completion=${cumulativeUsage.completion_tokens} total=${cumulativeUsage.total_tokens}`,
  ];

  if (typeof tokenLimit === "number") {
    const ratio = ((cumulativeUsage.total_tokens / tokenLimit) * 100).toFixed(
      1,
    );
    lines.push(`[status] token_limit=${tokenLimit} (${ratio}%)`);
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

  io.writeLine(`Chat loop started. model=${currentModel}`);
  io.writeLine("Type /exit to quit.");
  io.writeLine("Submit with Cmd+Enter (macOS) or Ctrl+Enter (Windows/Linux).");

  while (true) {
    const inputResult = await io.readUserInput("> ");
    const userInput = inputResult.value.trim();

    if (!userInput) {
      continue;
    }

    const slash = parseSlashCommand(userInput);
    if (slash) {
      if (slash.name === "help") {
        for (const line of HELP_LINES) {
          io.writeLine(line);
        }
        continue;
      }

      if (slash.name === "status") {
        const statusLines = formatStatus({
          model: currentModel,
          baseUrl: currentBaseUrl,
          configuredModelCount: configuredModelNames.length,
          messageCount: messages.length,
          lastUsage,
          cumulativeUsage,
          tokenLimit: resolveTokenLimit(currentModel),
        });
        for (const line of statusLines) {
          io.writeLine(line);
        }
        continue;
      }

      if (slash.name === "model") {
        if (configuredModelNames.length === 0) {
          io.writeError("[error] no models found in .agents/vibe-config.json");
          continue;
        }

        const selectableModels = [
          currentModel,
          ...configuredModelNames
            .filter((modelName) => modelName !== currentModel)
            .sort(),
        ];
        const requested = await io.selectModel(selectableModels, currentModel);

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
        io.writeLine(
          `[status] switched model to ${currentModel} (base_url=${currentBaseUrl})`,
        );
        continue;
      }

      if (slash.name === "new") {
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
        io.writeLine("[status] started a new session");
        continue;
      }

      if (slash.name === "exit" || slash.name === "quit") {
        io.writeLine("See you again!");
        return;
      }

      io.writeError(`[error] unknown slash command: /${slash.name}`);
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

      let printedFinal = false;

      for (let round = 0; round < config.maxToolRounds; round++) {
        io.writeLine(
          `[status] thinking... (round ${round + 1}/${config.maxToolRounds})`,
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
          io.writeLine(
            "[status] no tool call in round 1, retrying with tool_choice=required",
          );
        }

        if (!assistantMessage) {
          io.writeLine("[assistant] (empty response)");
          printedFinal = true;
          break;
        }

        const toolCalls = getToolCalls(assistantMessage);

        if (toolCalls.length === 0) {
          const assistantText = getAssistantContent(assistantMessage);
          messages = withAssistantFinalMessage(messages, assistantText);

          if (!assistantText) {
            io.writeLine("[assistant] (empty response)");
          } else {
            io.writeLine(`\n${assistantText}\n`);
          }

          printedFinal = true;
          break;
        }

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

          io.writeLine(`\n[tool] calling ${toolName}`);
          io.writeLine(
            `[tool] args: ${toPreview(toolCall.function.arguments, config.maxPreviewChars)}`,
          );

          const parsedArgs = parseToolArgs(toolCall.function.arguments);
          if (!parsedArgs.ok) {
            const failure = buildToolFailure(
              "invalid_arguments_json",
              parsedArgs.error,
            );
            messages = withToolResult(messages, toolCall.id, failure);
            io.writeLine(
              `[tool] error: invalid arguments JSON: ${parsedArgs.error}`,
            );
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
            io.writeLine(`[tool] error: ${unavailableMessage}`);
            continue;
          }

          try {
            const result = await io.runWithSpinner(
              `[tool] running ${toolName}`,
              () => toolRuntime.invoke(toolName, parsedArgs.value),
            );
            messages = withToolResult(messages, toolCall.id, result);
            io.writeLine(`[tool] response from ${toolName}:`);
            io.writeLine(toPreview(result, config.maxPreviewChars));
          } catch (error) {
            const invokeError =
              error instanceof Error ? error.message : String(error);
            const failure = buildToolFailure("tool_invoke_error", invokeError);
            messages = withToolResult(messages, toolCall.id, failure);
            io.writeLine(`[tool] error from ${toolName}: ${invokeError}`);
          }
        }
      }

      if (!printedFinal) {
        io.writeLine(
          `[assistant] tool loop reached max rounds (${config.maxToolRounds}).`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.writeError(`Request failed: ${message}`);
    }
  }
}
