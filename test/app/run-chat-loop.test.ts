import { describe, expect, test } from "bun:test";
import { runChatLoop } from "../../src/app/run-chat-loop";
import type {
  ChatMessage,
  CompletionGateway,
  CompletionTool,
  ConsoleIO,
  RuntimeConfig,
  ToolRuntime,
} from "../../src/domain/types";

describe("runChatLoop", () => {
  test("runs one prompt-response cycle and exits", async () => {
    const inputs = ["hello", "/exit"];
    const logs: string[] = [];

    const io: ConsoleIO = {
      async readUserInput() {
        return inputs.shift() ?? "/exit";
      },
      writeLine(message) {
        logs.push(message);
      },
      writeError(message) {
        logs.push(`ERR:${message}`);
      },
    };

    const completionGateway: CompletionGateway = {
      async request() {
        return {
          role: "assistant",
          content: "done",
          tool_calls: [],
          refusal: null,
        };
      },
    };

    const tools: CompletionTool[] = [];
    const toolRuntime: ToolRuntime = {
      getAllowedTools() {
        return tools;
      },
      getAllowedToolNames() {
        return [];
      },
      async invoke() {
        throw new Error("invoke should not be called");
      },
    };

    const config: RuntimeConfig = {
      model: "test-model",
      systemPrompt: "sys",
      maxToolRounds: 2,
      maxPreviewChars: 100,
      enforceToolCallFirstRound: false,
    };

    await runChatLoop({
      config,
      completionGateway,
      toolRuntime,
      io,
    });

    expect(logs.some((line) => line.includes("Chat loop started"))).toBe(true);
    expect(logs.some((line) => line.includes("[status] thinking"))).toBe(true);
    expect(logs.some((line) => line.includes("done"))).toBe(true);
    expect(logs.some((line) => line.startsWith("ERR:"))).toBe(false);
  });

  test("reports max round when assistant always returns tool calls", async () => {
    const inputs = ["hello", "/exit"];
    const logs: string[] = [];

    const io: ConsoleIO = {
      async readUserInput() {
        return inputs.shift() ?? "/exit";
      },
      writeLine(message) {
        logs.push(message);
      },
      writeError(message) {
        logs.push(`ERR:${message}`);
      },
    };

    const completionGateway: CompletionGateway = {
      async request() {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "noop", arguments: "{}" },
            },
          ],
          refusal: null,
        };
      },
    };

    const toolRuntime: ToolRuntime = {
      getAllowedTools() {
        return [];
      },
      getAllowedToolNames() {
        return [];
      },
      async invoke() {
        throw new Error("should not be called because tool is unavailable");
      },
    };

    const config: RuntimeConfig = {
      model: "test-model",
      systemPrompt: "sys",
      maxToolRounds: 1,
      maxPreviewChars: 100,
      enforceToolCallFirstRound: false,
    };

    await runChatLoop({
      config,
      completionGateway,
      toolRuntime,
      io,
    });

    expect(
      logs.some((line) => line.includes("tool loop reached max rounds (1)")),
    ).toBe(true);
  });
});
