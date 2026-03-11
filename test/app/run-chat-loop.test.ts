import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChatLoop } from "../../src/app/run-chat-loop";
import type {
  ChatMessage,
  CompletionGateway,
  CompletionTool,
  ConsoleIO,
  OpenAIUsage,
  RuntimeConfig,
  TokenStatusSnapshot,
  ToolRuntime,
} from "../../src/domain/types";
import { listSessionSummaries, loadSession } from "../../src/session/store";

const SESSION_PERSISTENCE_ENV = "VIBE_CLI_ENABLE_SESSION_PERSISTENCE";

function usage(total: number): OpenAIUsage {
  return {
    prompt_tokens: Math.floor(total / 2),
    completion_tokens: total - Math.floor(total / 2),
    total_tokens: total,
  };
}

function createTestIO(inputs: ReadonlyArray<string>) {
  const queue = [...inputs];
  const logs: string[] = [];
  const tokenSnapshots: TokenStatusSnapshot[] = [];
  const spinnerMessages: string[] = [];
  let resetCount = 0;
  let selectedModel = "alt-model";
  let selectedSessionPath = "";
  let selectSecurityBypassResult = false;
  const securityPrompts: Array<{ toolName: string; errorMessage: string }> = [];
  let lastModelOptions: string[] = [];
  let lastCurrentModel = "";

  const io: ConsoleIO = {
    async readUserInput(_prompt, options) {
      const value = queue.shift() ?? "/exit";
      const trimmed = value.trim();
      if (trimmed.startsWith("/")) {
        const slashTokens = trimmed
          .slice(1)
          .split(/\s+/)
          .filter((token) => token.length > 0);
        const commandName = slashTokens[0] ?? "";
        const command = options?.commands?.find(
          (candidate) => candidate.name === commandName,
        );
        if (command?.callback) {
          await command.callback(slashTokens.slice(1), value);
        }
      }
      return {
        value,
        mentionedPaths: value.includes("@README.md") ? ["README.md"] : [],
      };
    },
    async runWithSpinner(message, task) {
      spinnerMessages.push(message);
      return await task();
    },
    async selectModel(models, currentModel) {
      lastModelOptions = [...models];
      lastCurrentModel = currentModel;
      return selectedModel;
    },
    async selectSession(sessions) {
      return selectedSessionPath || sessions[0]?.path || "";
    },
    async selectSecurityBypass(toolName, errorMessage) {
      securityPrompts.push({ toolName, errorMessage });
      return selectSecurityBypassResult;
    },
    updateTokenStatus(snapshot) {
      tokenSnapshots.push(snapshot);
    },
    resetSessionUiState() {
      resetCount += 1;
    },
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

  return {
    io,
    logs,
    tokenSnapshots,
    spinnerMessages,
    setSelectedModel: (model: string) => {
      selectedModel = model;
    },
    setSelectSecurityBypassResult: (value: boolean) => {
      selectSecurityBypassResult = value;
    },
    setSelectedSessionPath: (value: string) => {
      selectedSessionPath = value;
    },
    getSecurityPrompts: () => securityPrompts,
    getLastModelOptions: () => lastModelOptions,
    getLastCurrentModel: () => lastCurrentModel,
    getResetCount: () => resetCount,
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
    modelContextLengths: {
      "test-model": 1000,
      "alt-model": 2000,
    },
    modelBaseUrls: {
      "test-model": "http://localhost:1234/v1",
      "alt-model": "http://localhost:2234/v1",
    },
    modelApiKeys: {
      "test-model": "lmstudio",
      "alt-model": "alt-key",
    },
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

describe("runChatLoop", () => {
  test("runs one prompt-response cycle and exits", async () => {
    const { io, logs, tokenSnapshots, spinnerMessages } = createTestIO([
      "hello",
      "/exit",
    ]);

    const completionGateway: CompletionGateway = {
      async request() {
        return {
          message: {
            role: "assistant",
            content: "done",
            tool_calls: [],
            refusal: null,
          },
          usage: usage(20),
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
        throw new Error("invoke should not be called");
      },
    };

    await runChatLoop({
      config: createConfig(),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(logs.some((line) => line.includes("Chat loop started"))).toBe(true);
    expect(logs.some((line) => line.includes("thinking"))).toBe(true);
    expect(logs.some((line) => line.includes("done"))).toBe(true);
    expect(logs.some((line) => line.startsWith("ERR:"))).toBe(false);
    expect(tokenSnapshots.at(-1)?.cumulativeUsage.total_tokens).toBe(20);
    expect(spinnerMessages.some((message) => message.includes("[model]"))).toBe(
      true,
    );
  });

  test("reports max round when assistant always returns tool calls", async () => {
    const { io, logs } = createTestIO(["hello", "/exit"]);

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
        throw new Error("should not be called because tool is unavailable");
      },
    };

    await runChatLoop({
      config: createConfig({ maxToolRounds: 1 }),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(
      logs.some((line) => line.includes("tool loop reached max rounds (1)")),
    ).toBe(true);
  });

  test("handles /new as full session reset", async () => {
    const { io, logs, tokenSnapshots, getResetCount } = createTestIO([
      "/new",
      "/status",
      "/exit",
    ]);

    const completionGateway: CompletionGateway = {
      async request() {
        return {
          message: null,
          usage: null,
        };
      },
    };

    const toolRuntime: ToolRuntime = {
      getAllowedTools() {
        return [];
      },
      getAllowedToolNames() {
        return ["read_file"];
      },
      async invoke() {
        throw new Error("not expected");
      },
    };

    await runChatLoop({
      config: createConfig(),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(getResetCount()).toBe(1);
    expect(logs.some((line) => line.includes("started a new session"))).toBe(
      true,
    );
    expect(
      logs.some((line) => line.includes("instruction_file=/tmp/AGENTS.md")),
    ).toBe(true);
    expect(logs.some((line) => line.includes("tokens(total)"))).toBe(true);
    expect(tokenSnapshots.at(-1)?.cumulativeUsage.total_tokens).toBe(0);
  });

  test("preloads mentioned files via read_file", async () => {
    const { io, logs, spinnerMessages } = createTestIO([
      "please check @README.md",
      "/exit",
    ]);

    const messageContents: string[] = [];
    const completionGateway: CompletionGateway = {
      async request(params) {
        const userMessage = params.messages.find(
          (
            message,
          ): message is ChatMessage & { role: "user"; content: string } =>
            message.role === "user" && typeof message.content === "string",
        );
        if (userMessage) {
          messageContents.push(userMessage.content);
        }

        return {
          message: {
            role: "assistant",
            content: "done",
            tool_calls: [],
            refusal: null,
          },
          usage: usage(8),
        };
      },
    };

    const toolRuntime: ToolRuntime = {
      getAllowedTools() {
        return [];
      },
      getAllowedToolNames() {
        return ["read_file"];
      },
      async invoke(toolName) {
        if (toolName !== "read_file") {
          throw new Error("unexpected tool");
        }

        return {
          path: "README.md",
          content: "line1\nline2",
          truncated: false,
        };
      },
    };

    await runChatLoop({
      config: createConfig(),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(messageContents[0]).toContain("[mentioned_files]");
    expect(messageContents[0]).toContain("@README.md");
    expect(
      spinnerMessages.some((message) => message.includes("[mention]")),
    ).toBe(true);
    expect(logs.some((line) => line.includes("Request failed"))).toBe(false);
  });

  test("switches model with /model and uses it for subsequent requests", async () => {
    const {
      io,
      logs,
      tokenSnapshots,
      getLastModelOptions,
      getLastCurrentModel,
    } = createTestIO(["/model alt-model", "hello", "/exit"]);

    const requestedModels: string[] = [];
    const requestedBaseUrls: string[] = [];
    const requestedApiKeys: string[] = [];
    const completionGateway: CompletionGateway = {
      async request(params) {
        requestedModels.push(params.model);
        requestedBaseUrls.push(params.baseUrl);
        requestedApiKeys.push(params.apiKey);
        return {
          message: {
            role: "assistant",
            content: "done",
            tool_calls: [],
            refusal: null,
          },
          usage: usage(10),
        };
      },
    };

    const toolRuntime: ToolRuntime = {
      getAllowedTools() {
        return [];
      },
      getAllowedToolNames() {
        return ["read_file"];
      },
      async invoke() {
        throw new Error("not expected");
      },
    };

    await runChatLoop({
      config: createConfig(),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(requestedModels).toEqual(["alt-model"]);
    expect(requestedBaseUrls).toEqual(["http://localhost:2234/v1"]);
    expect(requestedApiKeys).toEqual(["alt-key"]);
    expect(getLastCurrentModel()).toBe("test-model");
    expect(getLastModelOptions()).toEqual(["test-model", "alt-model"]);
    expect(
      logs.some((line) => line.includes("switched model to alt-model")),
    ).toBe(true);
    expect(tokenSnapshots.at(-1)?.model).toBe("alt-model");
    expect(tokenSnapshots.at(-1)?.tokenLimit).toBe(2000);
  });

  test("shows tool runtime security settings in /status", async () => {
    const { io, logs } = createTestIO(["/status", "/exit"]);

    const completionGateway: CompletionGateway = {
      async request() {
        return {
          message: null,
          usage: null,
        };
      },
    };

    const toolRuntime: ToolRuntime = {
      getAllowedTools() {
        return [];
      },
      getAllowedToolNames() {
        return ["read_file", "tree"];
      },
      getSecuritySummary() {
        return {
          writeScope: "read-only",
          defaultPolicy: "deny",
          explicitDenyTools: ["exec_command", "write_file"],
        };
      },
      async invoke() {
        throw new Error("not expected");
      },
    };

    await runChatLoop({
      config: createConfig(),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(logs.some((line) => line.includes("write_scope=read-only"))).toBe(
      true,
    );
    expect(logs.some((line) => line.includes("default_policy=deny"))).toBe(
      true,
    );
    expect(
      logs.some((line) =>
        line.includes("explicit_deny_tools=exec_command,write_file"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("chat_workflow_gate=on"))).toBe(
      true,
    );
  });

  test("toggles chat workflow gate with /workflow", async () => {
    const { io, logs } = createTestIO([
      "/workflow status",
      "/workflow off",
      "/status",
      "/workflow toggle",
      "/workflow status",
      "/exit",
    ]);

    const completionGateway: CompletionGateway = {
      async request() {
        return {
          message: null,
          usage: null,
        };
      },
    };

    const toolRuntime: ToolRuntime = {
      getAllowedTools() {
        return [];
      },
      getAllowedToolNames() {
        return ["read_file"];
      },
      async invoke() {
        throw new Error("not expected");
      },
    };

    await runChatLoop({
      config: createConfig(),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(logs).toContain("chat workflow gate is on");
    expect(logs).toContain("chat workflow gate disabled");
    expect(logs.some((line) => line.includes("chat_workflow_gate=off"))).toBe(
      true,
    );
    expect(logs).toContain("chat workflow gate enabled");
    expect(logs).toContain("chat workflow gate is on");
  });

  test("resets chat workflow gate to config default on /new", async () => {
    const { io, logs } = createTestIO([
      "/workflow off",
      "/new",
      "/status",
      "/exit",
    ]);

    const completionGateway: CompletionGateway = {
      async request() {
        return {
          message: null,
          usage: null,
        };
      },
    };

    const toolRuntime: ToolRuntime = {
      getAllowedTools() {
        return [];
      },
      getAllowedToolNames() {
        return ["read_file"];
      },
      async invoke() {
        throw new Error("not expected");
      },
    };

    await runChatLoop({
      config: createConfig({ chatWorkflowGateEnabled: true }),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(logs.some((line) => line.includes("chat_workflow_gate=on"))).toBe(
      true,
    );
  });

  test("does not enforce workflow gate in chat when disabled by config", async () => {
    const { io, logs } = createTestIO(["please fix", "/exit"]);
    let requestCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"README.md"}',
                  },
                },
              ],
              refusal: null,
            },
            usage: usage(4),
          };
        }

        return {
          message: {
            role: "assistant",
            content: "done",
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
        return ["read_file", "task_create_many", "task_validate_completion"];
      },
      async invoke() {
        return {
          status: "success",
          data: { path: "README.md", content: "hello", truncated: false },
        };
      },
    };

    await runChatLoop({
      config: createConfig({
        chatWorkflowGateEnabled: false,
        maxToolRounds: 2,
      }),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(
      logs.some((line) =>
        line.includes("workflow gate blocked final response"),
      ),
    ).toBe(false);
    expect(logs).toContain("done");
  });

  test("retries blocked tool call with SecurityBypass when user approves", async () => {
    const {
      io,
      logs,
      setSelectSecurityBypassResult,
      getSecurityPrompts,
      spinnerMessages,
    } = createTestIO(["hello", "/exit"]);
    setSelectSecurityBypassResult(true);

    let requestCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        requestCount += 1;

        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "exec_command", arguments: "{}" },
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
            content: "done",
            tool_calls: [],
            refusal: null,
          },
          usage: usage(5),
        };
      },
    };

    const invokeOptions: Array<{ securityBypass?: boolean }> = [];
    const toolRuntime: ToolRuntime = {
      getAllowedTools() {
        return [];
      },
      getAllowedToolNames() {
        return ["exec_command"];
      },
      async invoke(_toolName, _args, options) {
        invokeOptions.push(options ?? {});
        if (!options?.securityBypass) {
          throw new Error(
            'TOOL_NOT_ALLOWED: [Security Policy] Access denied for tool: "exec_command"',
          );
        }
        return { ok: true };
      },
    };

    await runChatLoop({
      config: createConfig(),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(getSecurityPrompts()).toHaveLength(1);
    expect(getSecurityPrompts()[0]?.toolName).toBe("exec_command");
    expect(invokeOptions).toEqual([{}, { securityBypass: true }]);
    expect(
      logs.some((line) =>
        line.includes("retrying exec_command with SecurityBypass"),
      ),
    ).toBe(true);
    expect(
      spinnerMessages.some((message) =>
        message.includes("[tool] running exec_command (SecurityBypass)"),
      ),
    ).toBe(true);
  });

  test("blocks final response for tool-driven turn until workflow requirements are met", async () => {
    const { io, logs } = createTestIO(["please fix", "/exit"]);
    let requestCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"README.md"}',
                  },
                },
              ],
              refusal: null,
            },
            usage: usage(4),
          };
        }

        return {
          message: {
            role: "assistant",
            content: "done",
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
        return ["read_file", "task_create_many", "task_validate_completion"];
      },
      async invoke() {
        return {
          status: "success",
          data: { path: "README.md", content: "hello", truncated: false },
        };
      },
    };

    await runChatLoop({
      config: createConfig({ maxToolRounds: 2 }),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(
      logs.some(
        (line) =>
          line.includes("hook gate blocked verify phase") ||
          line.includes("hook gate blocked final response"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line === "done")).toBe(false);
  });

  test("blocks file mutation before analysis and task creation in chat loop", async () => {
    const { io, logs } = createTestIO(["please fix", "/exit"]);
    let requestCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        requestCount += 1;
        if (requestCount === 1) {
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
                    arguments:
                      '{"filePath":"README.md","patch":"--- a/README.md"}',
                  },
                },
              ],
              refusal: null,
            },
            usage: usage(4),
          };
        }

        return {
          message: {
            role: "assistant",
            content: "",
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

    await runChatLoop({
      config: createConfig({ maxToolRounds: 2 }),
      completionGateway,
      toolRuntime,
      io,
    });

    expect(
      logs.some((line) => line.includes("workflow gate for apply_patch")),
    ).toBe(true);
  });

  test("retries when a done hook blocks finalization", async () => {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "chat-hook-block-"));
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
                  summary: "first done check failed",
                  stderr: "sanity failed",
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

    const { io, logs } = createTestIO(["hello", "/exit"]);
    let callCount = 0;
    const completionGateway: CompletionGateway = {
      async request() {
        callCount += 1;
        return {
          message: {
            role: "assistant",
            content: callCount === 1 ? "first try" : "done",
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
        return ["read_file"];
      },
      async invoke() {
        throw new Error("not expected");
      },
    };

    try {
      await runChatLoop({
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
        }),
        completionGateway,
        toolRuntime,
        io,
      });
    } finally {
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(callCount).toBe(2);
    expect(
      logs.some((line) => line.includes("hook gate blocked final response")),
    ).toBe(true);
    expect(logs.some((line) => line === "done")).toBe(true);
  });

  test("persists chat session messages and state to jsonl", async () => {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "chat-hook-log-"));
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    process.chdir(cwd);

    const { io, logs } = createTestIO(["hello", "/status", "/exit"]);
    const completionGateway: CompletionGateway = {
      async request() {
        return {
          message: {
            role: "assistant",
            content: "done",
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
        return ["read_file"];
      },
      async invoke() {
        throw new Error("not expected");
      },
    };

    const originalEnv = process.env[SESSION_PERSISTENCE_ENV];
    process.env[SESSION_PERSISTENCE_ENV] = "1";

    try {
      await runChatLoop({
        config: createConfig({
          workspaceRoot: cwd,
          configDirectory: join(cwd, ".agents"),
          configFilePath: join(cwd, ".agents", "vibe-config.json"),
        }),
        completionGateway,
        toolRuntime,
        io,
      });

      const sessions = listSessionSummaries(cwd);
      expect(sessions).toHaveLength(1);
      const loaded = loadSession(sessions[0]?.path ?? "");
      expect(loaded.messages.some((message) => message.role === "user")).toBe(
        true,
      );
      expect(
        loaded.messages.some((message) => message.role === "assistant"),
      ).toBe(true);
      expect(loaded.state.currentModel).toBe("test-model");
      expect(logs.some((line) => line.startsWith("session_id="))).toBe(true);
      expect(logs.some((line) => line.startsWith("session_file="))).toBe(true);
    } finally {
      if (originalEnv === undefined) {
        delete process.env[SESSION_PERSISTENCE_ENV];
      } else {
        process.env[SESSION_PERSISTENCE_ENV] = originalEnv;
      }
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("does not persist session files during bun test by default", async () => {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "chat-no-session-files-"));
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    process.chdir(cwd);

    const { io } = createTestIO(["hello", "/exit"]);
    const completionGateway: CompletionGateway = {
      async request() {
        return {
          message: {
            role: "assistant",
            content: "done",
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
        return ["read_file"];
      },
      async invoke() {
        throw new Error("not expected");
      },
    };

    try {
      await runChatLoop({
        config: createConfig({
          workspaceRoot: cwd,
          configDirectory: join(cwd, ".agents"),
          configFilePath: join(cwd, ".agents", "vibe-config.json"),
        }),
        completionGateway,
        toolRuntime,
        io,
      });

      expect(listSessionSummaries(cwd)).toHaveLength(0);
    } finally {
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("resumes saved session and continues appending to the same file", async () => {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "chat-resume-"));
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    process.chdir(cwd);

    const firstIo = createTestIO(["hello", "/exit"]);
    const firstGateway: CompletionGateway = {
      async request() {
        return {
          message: {
            role: "assistant",
            content: "first answer",
            tool_calls: [],
            refusal: null,
          },
          usage: usage(4),
        };
      },
    };
    const secondIo = createTestIO(["hello again", "/exit"]);
    const secondGateway: CompletionGateway = {
      async request() {
        return {
          message: {
            role: "assistant",
            content: "second answer",
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
        return ["read_file"];
      },
      async invoke() {
        throw new Error("not expected");
      },
    };

    const originalEnv = process.env[SESSION_PERSISTENCE_ENV];
    process.env[SESSION_PERSISTENCE_ENV] = "1";

    try {
      const config = createConfig({
        workspaceRoot: cwd,
        configDirectory: join(cwd, ".agents"),
        configFilePath: join(cwd, ".agents", "vibe-config.json"),
      });
      await runChatLoop({
        config,
        completionGateway: firstGateway,
        toolRuntime,
        io: firstIo.io,
      });

      const sessions = listSessionSummaries(cwd);
      expect(sessions).toHaveLength(1);

      await runChatLoop({
        config,
        completionGateway: secondGateway,
        toolRuntime,
        io: secondIo.io,
        resumeSelector: sessions[0]?.path ?? null,
      });

      const loaded = loadSession(sessions[0]?.path ?? "");
      expect(
        loaded.messages.filter((message) => message.role === "user").length,
      ).toBe(2);
      expect(
        loaded.messages.filter((message) => message.role === "assistant")
          .length,
      ).toBe(2);
      expect(loaded.state.cumulativeUsage.total_tokens).toBe(10);
    } finally {
      if (originalEnv === undefined) {
        delete process.env[SESSION_PERSISTENCE_ENV];
      } else {
        process.env[SESSION_PERSISTENCE_ENV] = originalEnv;
      }
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
