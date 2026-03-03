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

  io.writeLine(`Chat loop started. model=${config.model}`);
  io.writeLine("Type /exit to quit.");
  io.writeLine("Submit with Cmd+Enter (macOS) or Ctrl+Enter (Windows/Linux).");

  while (true) {
    const userInput = (await io.readUserInput("> ")).trim();

    if (!userInput) {
      continue;
    }

    if (userInput === "/exit" || userInput === "/quit") {
      io.writeLine("See you again!");
      process.exit(0);
    }

    messages = withUserMessage(messages, userInput);

    try {
      let printedFinal = false;

      for (let round = 0; round < config.maxToolRounds; round++) {
        io.writeLine(
          `[status] thinking... (round ${round + 1}/${config.maxToolRounds})`,
        );

        const { message: assistantMessage, retriedWithRequired } =
          await requestAssistantMessage({
            gateway: completionGateway,
            model: config.model,
            messages,
            tools,
            round,
            enforceToolCallFirstRound: config.enforceToolCallFirstRound,
          });

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
            const result = await toolRuntime.invoke(toolName, parsedArgs.value);
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
