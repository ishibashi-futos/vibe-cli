import { describe, expect, test } from "bun:test";
import { loadAppConfig } from "../../src/config/runtime-config";

describe("runtime-config", () => {
  test("loads defaults when env variables are absent", () => {
    const config = loadAppConfig({}, "default-system");

    expect(config.baseUrl).toBe("http://192.168.10.13:1234/v1");
    expect(config.apiKey).toBe("lmstudio");
    expect(config.model).toBe("qwen2.5-coder-7b-instruct-mlx");
    expect(config.systemPrompt).toBe("default-system");
    expect(config.maxToolRounds).toBe(12);
    expect(config.maxPreviewChars).toBe(4000);
    expect(config.enforceToolCallFirstRound).toBe(true);
  });

  test("uses explicit env values", () => {
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
    expect(config.enforceToolCallFirstRound).toBe(false);
  });
});
