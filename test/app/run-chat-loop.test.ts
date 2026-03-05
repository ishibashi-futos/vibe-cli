import { describe, expect, test } from "bun:test";
import { runChatLoop } from "../../src/app/run-chat-loop";
import type {
  ChatMessage,
  CompletionGateway,
  CompletionTool,
  ConsoleIO,
  OpenAIUsage,
  ReadUserInputResult,
  RuntimeConfig,
  TokenStatusSnapshot,
  ToolRuntime,
} from "../../src/domain/types";

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
  let lastModelOptions: string[] = [];
  let lastCurrentModel = "";

  const io: ConsoleIO = {
    async readUserInput() {
      const value = queue.shift() ?? "/exit";
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
    updateTokenStatus(snapshot) {
      tokenSnapshots.push(snapshot);
    },
    resetSessionUiState() {
      resetCount += 1;
    },
    writeLine(message) {
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
    getLastModelOptions: () => lastModelOptions,
    getLastCurrentModel: () => lastCurrentModel,
    getResetCount: () => resetCount,
  };
}

function createConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
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
    expect(logs.some((line) => line.includes("[status] thinking"))).toBe(true);
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
    expect(
      logs.some((line) => line.includes("[status] started a new session")),
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes("[status] instruction_file=/tmp/AGENTS.md"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("[status] tokens(total)"))).toBe(
      true,
    );
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
      logs.some((line) =>
        line.includes("[status] switched model to alt-model"),
      ),
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

    expect(
      logs.some((line) => line.includes("[status] write_scope=read-only")),
    ).toBe(true);
    expect(
      logs.some((line) => line.includes("[status] default_policy=deny")),
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes("[status] explicit_deny_tools=exec_command,write_file"),
      ),
    ).toBe(true);
  });
});
