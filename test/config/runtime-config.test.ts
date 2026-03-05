import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        const config = loadAppConfig({}, "default-system");

        expect(config.baseUrl).toBe("http://localhost:1234/v1");
        expect(config.apiKey).toBe("lmstudio");
        expect(config.model).toBe("qwen2.5-coder-7b-instruct-mlx");
        expect(config.systemPrompt).toBe("default-system");
        expect(config.agentInstructionPath).toBeNull();
        expect(config.maxToolRounds).toBe(12);
        expect(config.maxPreviewChars).toBe(4000);
        expect(config.enforceToolCallFirstRound).toBe(true);
        expect(config.mentionMaxLines).toBe(100);
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

  test("uses explicit env values", () => {
    withTestCwd(
      JSON.stringify({
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
      {},
      () => {
        const config = loadAppConfig(
          {
            OPENAI_BASE_URL: "http://localhost:1234/v1",
            OPENAI_API_KEY: "key",
            OPENAI_MODEL: "gpt-x",
            SYSTEM_PROMPT: "sys",
            ENFORCE_TOOL_CALL_FIRST_ROUND: "0",
          },
          "default-system",
        );

        expect(config.baseUrl).toBe("http://localhost:1234/v1");
        expect(config.apiKey).toBe("key");
        expect(config.model).toBe("gpt-x");
        expect(config.systemPrompt).toBe("sys");
        expect(config.agentInstructionPath).toBeNull();
        expect(config.enforceToolCallFirstRound).toBe(false);
        expect(config.modelTokenLimit).toBe(100000);
        expect(config.modelBaseUrls["gpt-x"]).toBe("http://127.0.0.1:9999/v1");
        expect(config.modelApiKeys["gpt-x"]).toBe("gpt-x-key");
      },
    );
  });

  test("falls back safely when .agents/vibe-config.json is missing", () => {
    withTestCwd(null, {}, () => {
      const config = loadAppConfig({}, "default-system");
      expect(config.modelContextLengths).toEqual({});
      expect(config.modelBaseUrls).toEqual({});
      expect(config.modelApiKeys).toEqual({});
      expect(config.modelTokenLimit).toBeNull();
      expect(config.agentInstructionPath).toBeNull();
    });
  });

  test("appends AGENTS.md content to default system prompt", () => {
    withTestCwd(
      JSON.stringify({ models: {} }),
      { "AGENTS.md": "project instructions" },
      () => {
        const config = loadAppConfig({}, "default-system");
        expect(config.systemPrompt).toBe(
          "default-system\n\nproject instructions",
        );
        expect(config.agentInstructionPath).toBe(
          join(process.cwd(), "AGENTS.md"),
        );
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
        const config = loadAppConfig({}, "default-system");
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
        const config = loadAppConfig({}, "default-system");
        expect(config.systemPrompt).toBe(
          "default-system\n\ndefault instructions",
        );
        expect(config.agentInstructionPath).toBe(
          join(process.cwd(), "AGENTS.md"),
        );
      },
    );
  });
});
