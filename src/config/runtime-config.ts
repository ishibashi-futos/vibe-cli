import type { RuntimeConfig } from "../domain/types";

const DEFAULT_BASE_URL = "http://192.168.10.13:1234/v1";
const DEFAULT_API_KEY = "lmstudio";
const DEFAULT_MODEL = "qwen2.5-coder-7b-instruct-mlx";
const DEFAULT_MAX_TOOL_ROUNDS = 12;
const DEFAULT_MAX_PREVIEW_CHARS = 4000;

export interface AppConfig extends RuntimeConfig {
  baseUrl: string;
  apiKey: string;
}

export function loadAppConfig(
  env: NodeJS.ProcessEnv,
  defaultSystemPrompt: string,
): AppConfig {
  return {
    baseUrl: env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: env.OPENAI_API_KEY ?? DEFAULT_API_KEY,
    model: env.OPENAI_MODEL ?? DEFAULT_MODEL,
    systemPrompt: env.SYSTEM_PROMPT ?? defaultSystemPrompt,
    maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
    maxPreviewChars: DEFAULT_MAX_PREVIEW_CHARS,
    enforceToolCallFirstRound: env.ENFORCE_TOOL_CALL_FIRST_ROUND !== "0",
  };
}
