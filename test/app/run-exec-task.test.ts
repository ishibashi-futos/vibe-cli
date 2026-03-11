import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const workspaceRoot = process.cwd();
  return {
    workspaceRoot,
    configDirectory: join(workspaceRoot, ".agents"),
    configFilePath: join(workspaceRoot, ".agents", "vibe-config.json"),
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
    chatWorkflowGateEnabled: true,
    hooks: [],
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

  test("returns success when workflow requirements are satisfied", async () => {
    const logs: string[] = [];
    let callCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        callCount += 1;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "regexp_search",
                    arguments: '{"pattern":"runExecTask"}',
                  },
                },
                {
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "task_create_many",
                    arguments:
                      '{"tasks":[{"title":"inspect"},{"title":"finish"}]}',
                  },
                },
                {
                  id: "call_3",
                  type: "function",
                  function: {
                    name: "task_validate_completion",
                    arguments: "{}",
                  },
                },
              ],
              refusal: null,
            },
            usage: usage(10),
          };
        }

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
        return [
          "regexp_search",
          "task_create_many",
          "task_validate_completion",
        ];
      },
      async invoke(toolName) {
        if (toolName === "regexp_search") {
          return { status: "success", data: { matches: [] } };
        }
        if (toolName === "task_create_many") {
          return { status: "success", data: { tasks: [] } };
        }
        if (toolName === "task_validate_completion") {
          return { status: "success", data: { ok: true, remaining: [] } };
        }
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

  test("continues when completion token is missing after workflow requirements are satisfied", async () => {
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
                ? ""
                : callCount === 2
                  ? "still working"
                  : "<EXEC_SUMMARY>final result</EXEC_SUMMARY><EXEC_DONE />",
            tool_calls:
              callCount === 1
                ? [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "regexp_search",
                        arguments: '{"pattern":"hello"}',
                      },
                    },
                    {
                      id: "call_2",
                      type: "function",
                      function: {
                        name: "task_create_many",
                        arguments: '{"tasks":[{"title":"one"}]}',
                      },
                    },
                    {
                      id: "call_3",
                      type: "function",
                      function: {
                        name: "task_validate_completion",
                        arguments: "{}",
                      },
                    },
                  ]
                : [],
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
        return [
          "regexp_search",
          "task_create_many",
          "task_validate_completion",
        ];
      },
      async invoke(toolName) {
        if (toolName === "regexp_search") {
          return { status: "success", data: { matches: [] } };
        }
        if (toolName === "task_create_many") {
          return { status: "success", data: { tasks: [] } };
        }
        if (toolName === "task_validate_completion") {
          return { status: "success", data: { ok: true, remaining: [] } };
        }
        throw new Error("not expected");
      },
    };

    const result = await runExecTask({
      instruction: "hello",
      config: createConfig({ maxToolRounds: 3 }),
      completionGateway,
      toolRuntime,
      io: createTestIO(logs),
    });

    expect(result).toEqual({ success: true, exitCode: 0 });
    expect(callCount).toBe(3);
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
            content:
              callCount === 1
                ? ""
                : "<EXEC_SUMMARY>final result in Japanese</EXEC_SUMMARY>",
            tool_calls:
              callCount === 1
                ? [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "regexp_search",
                        arguments: '{"pattern":"hello"}',
                      },
                    },
                    {
                      id: "call_2",
                      type: "function",
                      function: {
                        name: "task_create_many",
                        arguments: '{"tasks":[{"title":"one"}]}',
                      },
                    },
                    {
                      id: "call_3",
                      type: "function",
                      function: {
                        name: "task_validate_completion",
                        arguments: "{}",
                      },
                    },
                  ]
                : [],
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
        return [
          "regexp_search",
          "task_create_many",
          "task_validate_completion",
        ];
      },
      async invoke(toolName) {
        if (toolName === "regexp_search") {
          return { status: "success", data: { matches: [] } };
        }
        if (toolName === "task_create_many") {
          return { status: "success", data: { tasks: [] } };
        }
        if (toolName === "task_validate_completion") {
          return { status: "success", data: { ok: true, remaining: [] } };
        }
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
    expect(callCount).toBe(3);
    expect(
      logs.some((line) => line.includes("forcing completion output")),
    ).toBe(true);
    expect(logs).toContain("<EXEC_DONE />");
  });

  test("blocks final response until workflow requirements are met", async () => {
    const logs: string[] = [];
    let callCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        callCount += 1;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "<EXEC_SUMMARY>done early</EXEC_SUMMARY><EXEC_DONE />",
              tool_calls: [],
              refusal: null,
            },
            usage: usage(6),
          };
        }

        return {
          message: {
            role: "assistant",
            content:
              callCount === 2
                ? ""
                : "<EXEC_SUMMARY>done after workflow</EXEC_SUMMARY><EXEC_DONE />",
            tool_calls:
              callCount === 2
                ? [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "regexp_search",
                        arguments: '{"pattern":"hello"}',
                      },
                    },
                    {
                      id: "call_2",
                      type: "function",
                      function: {
                        name: "task_create_many",
                        arguments: '{"tasks":[{"title":"one"}]}',
                      },
                    },
                    {
                      id: "call_3",
                      type: "function",
                      function: {
                        name: "task_validate_completion",
                        arguments: "{}",
                      },
                    },
                  ]
                : [],
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
        return [
          "regexp_search",
          "task_create_many",
          "task_validate_completion",
        ];
      },
      async invoke(toolName) {
        if (toolName === "regexp_search") {
          return { status: "success", data: { matches: [] } };
        }
        if (toolName === "task_create_many") {
          return { status: "success", data: { tasks: [] } };
        }
        if (toolName === "task_validate_completion") {
          return { status: "success", data: { ok: true, remaining: [] } };
        }
        throw new Error("not expected");
      },
    };

    const result = await runExecTask({
      instruction: "hello",
      config: createConfig({ maxToolRounds: 3 }),
      completionGateway,
      toolRuntime,
      io: createTestIO(logs),
    });

    expect(result).toEqual({ success: true, exitCode: 0 });
    expect(callCount).toBe(3);
    expect(
      logs.some(
        (line) =>
          line.includes("hook gate blocked verify phase") ||
          line.includes("hook gate blocked final response"),
      ),
    ).toBe(true);
  });

  test("blocks file mutation until analysis and todo setup are complete", async () => {
    const logs: string[] = [];
    let callCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        callCount += 1;
        if (callCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "apply_patch",
                    arguments: JSON.stringify({
                      filePath: "README.md",
                      patch: "--- a/README.md",
                    }),
                  },
                },
              ],
              refusal: null,
            },
            usage: usage(5),
          };
        }

        return {
          message: {
            role: "assistant",
            content: "<EXEC_SUMMARY>stopped</EXEC_SUMMARY><EXEC_DONE />",
            tool_calls: [],
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
        return [
          "apply_patch",
          "regexp_search",
          "task_create_many",
          "task_validate_completion",
        ];
      },
      async invoke() {
        throw new Error("apply_patch should be blocked before invoke");
      },
    };

    const result = await runExecTask({
      instruction: "hello",
      config: createConfig({ maxToolRounds: 2 }),
      completionGateway,
      toolRuntime,
      io: createTestIO(logs),
    });

    expect(result).toEqual({ success: false, exitCode: 1 });
    expect(
      logs.some((line) => line.includes("workflow gate for apply_patch")),
    ).toBe(true);
  });

  test("retries when a done hook blocks finalization", async () => {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "exec-hook-block-"));
    mkdirSync(join(cwd, ".agents", "hooks", "blocker"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents", "hooks", "blocker", "index.ts"),
      `
        let seen = false;
        export default {
          handle(event) {
            if (event.name !== "phase.check" || event.phase !== "done") {
              return { kind: "continue" };
            }
            if (!seen) {
              seen = true;
              return {
                kind: "block_finalize",
                artifacts: {
                  summary: "run sanity failed",
                },
              };
            }
            return { kind: "continue" };
          },
        };
      `,
      "utf8",
    );
    process.chdir(cwd);

    const logs: string[] = [];
    let callCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        callCount += 1;
        return {
          message: {
            role: "assistant",
            content:
              callCount <= 2
                ? ""
                : "<EXEC_SUMMARY>final result</EXEC_SUMMARY><EXEC_DONE />",
            tool_calls:
              callCount === 1
                ? [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "task_create_many",
                        arguments: '{"tasks":[{"title":"setup"}]}',
                      },
                    },
                    {
                      id: "call_2",
                      type: "function",
                      function: {
                        name: "task_validate_completion",
                        arguments: "{}",
                      },
                    },
                  ]
                : [],
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
        return ["task_create_many", "task_validate_completion"];
      },
      async invoke(toolName) {
        if (toolName === "task_create_many") {
          return { status: "success", data: { tasks: [] } };
        }
        if (toolName === "task_validate_completion") {
          return { status: "success", data: { ok: true, remaining: [] } };
        }
        throw new Error("not expected");
      },
    };

    try {
      const result = await runExecTask({
        instruction: "hello",
        config: createConfig({
          workspaceRoot: cwd,
          configDirectory: join(cwd, ".agents"),
          hooks: [
            {
              hookName: "blocker",
              onError: "warn",
              phases: { done: true },
              config: {},
            },
          ],
          maxToolRounds: 3,
        }),
        completionGateway,
        toolRuntime,
        io: createTestIO(logs),
      });

      expect(result).toEqual({ success: true, exitCode: 0 });
    } finally {
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(callCount).toBe(3);
    expect(
      logs.some((line) =>
        line.includes("[exec] hook gate blocked final response"),
      ),
    ).toBe(true);
    expect(logs).toContain("final result");
  });
});
