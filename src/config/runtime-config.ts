import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "../domain/types";

const DEFAULT_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_API_KEY = "lmstudio";
const DEFAULT_MODEL = "qwen2.5-coder-7b-instruct-mlx";
const DEFAULT_MAX_TOOL_ROUNDS = 12;
const DEFAULT_MAX_PREVIEW_CHARS = 4000;
const DEFAULT_MENTION_MAX_LINES = 100;

type ModelTokenLimitMap = Record<string, number>;
type ModelStringMap = Record<string, string>;
interface LoadedVibeModelConfig {
  contextLengths: ModelTokenLimitMap;
  baseUrls: ModelStringMap;
  apiKeys: ModelStringMap;
}

function loadVibeModelConfig(cwd: string): LoadedVibeModelConfig {
  const filePath = join(cwd, ".agents", "vibe-config.json");
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { contextLengths: {}, baseUrls: {}, apiKeys: {} };
    }

    const models = (parsed as Record<string, unknown>).models;
    if (
      typeof models !== "object" ||
      models === null ||
      Array.isArray(models)
    ) {
      return { contextLengths: {}, baseUrls: {}, apiKeys: {} };
    }

    const contextLengths: ModelTokenLimitMap = {};
    const baseUrls: ModelStringMap = {};
    const apiKeys: ModelStringMap = {};
    for (const [model, definition] of Object.entries(
      models as Record<string, unknown>,
    )) {
      if (
        typeof definition !== "object" ||
        definition === null ||
        Array.isArray(definition)
      ) {
        continue;
      }

      const contextLength = (definition as Record<string, unknown>)
        .context_length;
      if (
        typeof contextLength !== "number" ||
        !Number.isInteger(contextLength) ||
        contextLength <= 0
      ) {
      } else {
        contextLengths[model] = contextLength;
      }

      const baseUrl = (definition as Record<string, unknown>).base_url;
      if (typeof baseUrl === "string" && baseUrl.length > 0) {
        baseUrls[model] = baseUrl;
      }

      const apiKey = (definition as Record<string, unknown>).api_key;
      if (typeof apiKey === "string" && apiKey.length > 0) {
        apiKeys[model] = apiKey;
      }
    }
    return { contextLengths, baseUrls, apiKeys };
  } catch {
    return { contextLengths: {}, baseUrls: {}, apiKeys: {} };
  }
}

export interface AppConfig extends RuntimeConfig {}

export function loadAppConfig(
  env: NodeJS.ProcessEnv,
  defaultSystemPrompt: string,
): AppConfig {
  const model = env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const loaded = loadVibeModelConfig(process.cwd());

  return {
    baseUrl: env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: env.OPENAI_API_KEY ?? DEFAULT_API_KEY,
    model,
    modelContextLengths: loaded.contextLengths,
    modelBaseUrls: loaded.baseUrls,
    modelApiKeys: loaded.apiKeys,
    systemPrompt: env.SYSTEM_PROMPT ?? defaultSystemPrompt,
    maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
    maxPreviewChars: DEFAULT_MAX_PREVIEW_CHARS,
    enforceToolCallFirstRound: env.ENFORCE_TOOL_CALL_FIRST_ROUND !== "0",
    modelTokenLimit: loaded.contextLengths[model] ?? null,
    mentionMaxLines: DEFAULT_MENTION_MAX_LINES,
  };
}
