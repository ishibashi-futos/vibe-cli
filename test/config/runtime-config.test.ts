import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadAppConfig } from "../../src/config/runtime-config";

describe("runtime-config", () => {
  function withTestCwd(
    vibeConfig: string | null,
    files: Record<string, string>,
    run: () => void,
  ): void {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "vibe-config-test-"));
    try {
      if (vibeConfig !== null) {
        mkdirSync(join(cwd, ".agents"), { recursive: true });
        writeFileSync(join(cwd, ".agents", "vibe-config.json"), vibeConfig);
      }
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(cwd, path)), { recursive: true });
        writeFileSync(join(cwd, path), content);
      }
      process.chdir(cwd);
      run();
    } finally {
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  test("loads defaults when env variables are absent", () => {
    withTestCwd(
      JSON.stringify({
        models: {
          "qwen2.5-coder-7b-instruct-mlx": {
            context_length: 32768,
            base_url: "http://127.0.0.1:1234/v1",
            api_key: "from-config",
          },
        },
      }),
      {},
      () => {
        const config = loadAppConfig("default-system");

        expect(config.workspaceRoot).toBe(process.cwd());
        expect(config.configDirectory).toBe(join(process.cwd(), ".agents"));
        expect(config.baseUrl).toBe("http://localhost:1234/v1");
        expect(config.apiKey).toBe("lmstudio");
        expect(config.model).toBe("qwen2.5-coder-7b-instruct-mlx");
        expect(config.systemPrompt).toBe("default-system");
        expect(config.agentInstructionPath).toBeNull();
        expect(config.maxToolRounds).toBe(12);
        expect(config.maxPreviewChars).toBe(4000);
        expect(config.enforceToolCallFirstRound).toBe(true);
        expect(config.mentionMaxLines).toBe(100);
        expect(config.chatWorkflowGateEnabled).toBe(true);
        expect(config.hooks).toEqual([]);
        expect(config.modelTokenLimit).toBe(32768);
        expect(config.modelContextLengths).toEqual({
          "qwen2.5-coder-7b-instruct-mlx": 32768,
        });
        expect(config.modelBaseUrls).toEqual({
          "qwen2.5-coder-7b-instruct-mlx": "http://127.0.0.1:1234/v1",
        });
        expect(config.modelApiKeys).toEqual({
          "qwen2.5-coder-7b-instruct-mlx": "from-config",
        });
      },
    );
  });

  test("loads runtime settings from .agents/vibe-config.json", () => {
    withTestCwd(
      JSON.stringify({
        default_model: "gpt-x",
        system_prompt_file: "SYSTEM_PROMPT.md",
        enforce_tool_call_first_round: false,
        max_tool_rounds: 24,
        max_preview_chars: 2048,
        mention_max_lines: 42,
        chat_workflow_gate_enabled: false,
        models: {
          "qwen2.5-coder-7b-instruct-mlx": {
            context_length: 32768,
            base_url: "http://127.0.0.1:1234/v1",
            api_key: "from-config",
          },
          "gpt-x": {
            context_length: 100000,
            base_url: "http://127.0.0.1:9999/v1",
            api_key: "gpt-x-key",
          },
        },
      }),
      {
        "SYSTEM_PROMPT.md": "sys",
      },
      () => {
        const config = loadAppConfig("default-system");

        expect(config.workspaceRoot).toBe(process.cwd());
        expect(config.configDirectory).toBe(join(process.cwd(), ".agents"));
        expect(config.baseUrl).toBe("http://localhost:1234/v1");
        expect(config.apiKey).toBe("lmstudio");
        expect(config.model).toBe("gpt-x");
        expect(config.systemPrompt).toBe("sys");
        expect(config.agentInstructionPath).toBeNull();
        expect(config.enforceToolCallFirstRound).toBe(false);
        expect(config.maxToolRounds).toBe(24);
        expect(config.maxPreviewChars).toBe(2048);
        expect(config.mentionMaxLines).toBe(42);
        expect(config.chatWorkflowGateEnabled).toBe(false);
        expect(config.hooks).toEqual([]);
        expect(config.modelTokenLimit).toBe(100000);
        expect(config.modelBaseUrls["gpt-x"]).toBe("http://127.0.0.1:9999/v1");
        expect(config.modelApiKeys["gpt-x"]).toBe("gpt-x-key");
      },
    );
  });

  test("falls back to default system prompt when system_prompt_file is missing", () => {
    withTestCwd(
      JSON.stringify({
        system_prompt_file: "MISSING_SYSTEM_PROMPT.md",
        models: {},
      }),
      {
        "AGENTS.md": "project instructions",
      },
      () => {
        const config = loadAppConfig("default-system");
        expect(config.systemPrompt).toBe(
          "default-system\n\nproject instructions",
        );
        expect(config.agentInstructionPath).toBe(
          join(process.cwd(), "AGENTS.md"),
        );
      },
    );
  });

  test("falls back to the first configured model when default_model is omitted", () => {
    withTestCwd(
      JSON.stringify({
        models: {
          "first-model": {
            context_length: 8192,
          },
          "second-model": {
            context_length: 16384,
          },
        },
      }),
      {},
      () => {
        const config = loadAppConfig("default-system");
        expect(config.model).toBe("first-model");
        expect(config.modelTokenLimit).toBe(8192);
      },
    );
  });

  test("throws when default_model is not defined under models", () => {
    withTestCwd(
      JSON.stringify({
        default_model: "missing-model",
        models: {
          "first-model": {
            context_length: 8192,
          },
        },
      }),
      {},
      () => {
        expect(() => loadAppConfig("default-system")).toThrow(
          'invalid .agents/vibe-config.json: default_model "missing-model" is not defined under models',
        );
      },
    );
  });

  test("falls back safely when .agents/vibe-config.json is missing", () => {
    withTestCwd(null, {}, () => {
      const config = loadAppConfig("default-system");
      expect(config.workspaceRoot).toBe(process.cwd());
      expect(config.configDirectory).toBe(join(process.cwd(), ".agents"));
      expect(config.modelContextLengths).toEqual({});
      expect(config.modelBaseUrls).toEqual({});
      expect(config.modelApiKeys).toEqual({});
      expect(config.modelTokenLimit).toBeNull();
      expect(config.agentInstructionPath).toBeNull();
      expect(config.hooks).toEqual([]);
    });
  });

  test("loads hooks in declaration order", () => {
    withTestCwd(
      JSON.stringify({
        models: {},
        hooks: {
          sanity: {
            on_error: "abort",
            phases: {
              done: true,
            },
            config: {
              command: ["bun", "run", "sanity"],
            },
          },
          notify: {
            on_error: "warn",
          },
        },
      }),
      {},
      () => {
        const config = loadAppConfig("default-system");
        expect(config.hooks).toEqual([
          {
            hookName: "sanity",
            onError: "abort",
            phases: { done: true },
            config: {
              command: ["bun", "run", "sanity"],
            },
          },
          {
            hookName: "notify",
            onError: "warn",
            phases: null,
            config: {},
          },
        ]);
      },
    );
  });

  test("appends AGENTS.md content to default system prompt", () => {
    withTestCwd(
      JSON.stringify({ models: {} }),
      { "AGENTS.md": "project instructions" },
      () => {
        const config = loadAppConfig("default-system");
        expect(config.systemPrompt).toBe(
          "default-system\n\nproject instructions",
        );
        expect(config.agentInstructionPath).toBe(
          join(process.cwd(), "AGENTS.md"),
        );
      },
    );
  });

  test("uses system_prompt_file instead of default system prompt and instruction_file", () => {
    withTestCwd(
      JSON.stringify({
        models: {},
        system_prompt_file: "SYSTEM_PROMPT.md",
        instruction_file: "CLAUDE.md",
      }),
      {
        "SYSTEM_PROMPT.md": "custom system prompt",
        "CLAUDE.md": "custom instructions",
      },
      () => {
        const config = loadAppConfig("default-system", {
          workflowSystemPromptContract: "workflow-contract",
        });
        expect(config.systemPrompt).toBe(
          "workflow-contract\n\ncustom system prompt",
        );
        expect(config.agentInstructionPath).toBeNull();
      },
    );
  });

  test("uses instruction_file from .agents/vibe-config.json", () => {
    withTestCwd(
      JSON.stringify({
        models: {},
        instruction_file: "CLAUDE.md",
      }),
      {
        "AGENTS.md": "default instructions",
        "CLAUDE.md": "custom instructions",
      },
      () => {
        const config = loadAppConfig("default-system");
        expect(config.systemPrompt).toBe(
          "default-system\n\ncustom instructions",
        );
        expect(config.agentInstructionPath).toBe(
          join(process.cwd(), "CLAUDE.md"),
        );
      },
    );
  });

  test("falls back to AGENTS.md when configured instruction_file is missing", () => {
    withTestCwd(
      JSON.stringify({
        models: {},
        instruction_file: "MISSING.md",
      }),
      { "AGENTS.md": "default instructions" },
      () => {
        const config = loadAppConfig("default-system");
        expect(config.systemPrompt).toBe(
          "default-system\n\ndefault instructions",
        );
        expect(config.agentInstructionPath).toBe(
          join(process.cwd(), "AGENTS.md"),
        );
      },
    );
  });

  test("loads from custom config file path and resolves instruction relative to that config", () => {
    withTestCwd(
      JSON.stringify({ models: {} }),
      {
        ".agents/review/vibe-config.json": JSON.stringify({
          models: {},
          instruction_file: "AGENTS.md",
        }),
        ".agents/review/AGENTS.md": "review instructions",
        "AGENTS.md": "root instructions",
      },
      () => {
        const config = loadAppConfig("default-system", {
          configFilePath: ".agents/review/vibe-config.json",
        });
        expect(config.systemPrompt).toBe(
          "default-system\n\nreview instructions",
        );
        expect(config.agentInstructionPath).toBe(
          join(process.cwd(), ".agents/review/AGENTS.md"),
        );
      },
    );
  });

  test("falls back to workspace AGENTS.md when custom config instruction is missing", () => {
    withTestCwd(
      JSON.stringify({ models: {} }),
      {
        ".agents/review/vibe-config.json": JSON.stringify({
          models: {},
          instruction_file: "AGENTS.md",
        }),
        "AGENTS.md": "root instructions",
      },
      () => {
        const config = loadAppConfig("default-system", {
          configFilePath: ".agents/review/vibe-config.json",
        });
        expect(config.systemPrompt).toBe("default-system\n\nroot instructions");
        expect(config.agentInstructionPath).toBe(
          join(process.cwd(), "AGENTS.md"),
        );
      },
    );
  });
});
