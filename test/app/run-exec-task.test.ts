import { describe, expect, test } from "bun:test";
import { runExecTask } from "../../src/app/run-exec-task";
import type {
  CompletionGateway,
  CompletionTool,
  ConsoleIO,
  OpenAIUsage,
  RuntimeConfig,
  ToolRuntime,
} from "../../src/domain/types";

function usage(total: number): OpenAIUsage {
  return {
    prompt_tokens: Math.floor(total / 2),
    completion_tokens: total - Math.floor(total / 2),
    total_tokens: total,
  };
}

function createConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "lmstudio",
    model: "test-model",
    modelContextLengths: { "test-model": 1000 },
    modelBaseUrls: { "test-model": "http://localhost:1234/v1" },
    modelApiKeys: { "test-model": "lmstudio" },
    systemPrompt: "sys",
    agentInstructionPath: "/tmp/AGENTS.md",
    maxToolRounds: 2,
    maxPreviewChars: 100,
    enforceToolCallFirstRound: false,
    mentionMaxLines: 100,
    modelTokenLimit: 1000,
    ...overrides,
  };
}

describe("runExecTask", () => {
  function createTestIO(
    logs: string[],
  ): Pick<
    ConsoleIO,
    "writeStatus" | "writeToolCall" | "writeOutput" | "writeError"
  > {
    return {
      writeStatus(message) {
        logs.push(message);
      },
      writeToolCall(name, args) {
        logs.push(
          args === undefined
            ? `TOOL:${name}`
            : `TOOL:${name} ${JSON.stringify(args)}`,
        );
      },
      writeOutput(message) {
        logs.push(message);
      },
      writeError(message) {
        logs.push(`ERR:${message}`);
      },
    };
  }

  test("returns success when assistant completes without tools", async () => {
    const logs: string[] = [];
    const completionGateway: CompletionGateway = {
      async request() {
        return {
          message: {
            role: "assistant",
            content:
              "<EXEC_SUMMARY>\nupdated files and ran tests\n</EXEC_SUMMARY>\n<EXEC_DONE />",
            tool_calls: [],
            refusal: null,
          },
          usage: usage(10),
        };
      },
    };

    const tools: CompletionTool[] = [];
    const toolRuntime: ToolRuntime = {
      getAllowedTools() {
        return tools;
      },
      getAllowedToolNames() {
        return ["read_file"];
      },
      async invoke() {
        throw new Error("not expected");
      },
    };

    const result = await runExecTask({
      instruction: "hello",
      config: createConfig(),
      completionGateway,
      toolRuntime,
      io: createTestIO(logs),
    });

    expect(result).toEqual({ success: true, exitCode: 0 });
    expect(logs.some((line) => line.includes("[exec] completed"))).toBe(true);
    expect(logs).toContain("<EXEC_SUMMARY>");
    expect(logs).toContain("</EXEC_SUMMARY>");
    expect(logs).toContain("<EXEC_DONE />");
    expect(logs).toContain("updated files and ran tests");
    expect(logs.some((line) => line.startsWith("ERR:"))).toBe(false);
  });

  test("continues when assistant response has no completion token", async () => {
    const logs: string[] = [];
    let callCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        callCount += 1;
        return {
          message: {
            role: "assistant",
            content:
              callCount === 1
                ? "still working"
                : "<EXEC_SUMMARY>final result</EXEC_SUMMARY><EXEC_DONE />",
            tool_calls: [],
            refusal: null,
          },
          usage: usage(6),
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
        throw new Error("not expected");
      },
    };

    const result = await runExecTask({
      instruction: "hello",
      config: createConfig(),
      completionGateway,
      toolRuntime,
      io: createTestIO(logs),
    });

    expect(result).toEqual({ success: true, exitCode: 0 });
    expect(callCount).toBe(2);
    expect(logs.some((line) => line.includes("missing completion token"))).toBe(
      true,
    );
  });

  test("returns non-zero when max rounds is reached", async () => {
    const logs: string[] = [];
    const completionGateway: CompletionGateway = {
      async request() {
        return {
          message: {
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
          },
          usage: usage(5),
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
        throw new Error("not expected");
      },
    };

    const result = await runExecTask({
      instruction: "hello",
      config: createConfig({ maxToolRounds: 1 }),
      completionGateway,
      toolRuntime,
      io: createTestIO(logs),
    });

    expect(result).toEqual({ success: false, exitCode: 1 });
    expect(
      logs.some((line) =>
        line.includes("reached max rounds without final answer"),
      ),
    ).toBe(true);
  });

  test("forces completion when completion token is still missing after retry", async () => {
    const logs: string[] = [];
    let callCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        callCount += 1;
        return {
          message: {
            role: "assistant",
            content: "<EXEC_SUMMARY>final result in Japanese</EXEC_SUMMARY>",
            tool_calls: [],
            refusal: null,
          },
          usage: usage(4),
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
        throw new Error("not expected");
      },
    };

    const result = await runExecTask({
      instruction: "hello",
      config: createConfig({ maxToolRounds: 6 }),
      completionGateway,
      toolRuntime,
      io: createTestIO(logs),
    });

    expect(result).toEqual({ success: true, exitCode: 0 });
    expect(callCount).toBe(2);
    expect(
      logs.some((line) => line.includes("forcing completion output")),
    ).toBe(true);
    expect(logs).toContain("<EXEC_DONE />");
  });
});
