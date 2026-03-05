import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RuntimeConfig } from "../domain/types";

const DEFAULT_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_API_KEY = "lmstudio";
const DEFAULT_MODEL = "qwen2.5-coder-7b-instruct-mlx";
const DEFAULT_MAX_TOOL_ROUNDS = 12;
const DEFAULT_MAX_PREVIEW_CHARS = 4000;
const DEFAULT_MENTION_MAX_LINES = 100;
const DEFAULT_AGENT_INSTRUCTION_FILE = "AGENTS.md";

type ModelTokenLimitMap = Record<string, number>;
type ModelStringMap = Record<string, string>;
interface LoadedVibeModelConfig {
  contextLengths: ModelTokenLimitMap;
  baseUrls: ModelStringMap;
  apiKeys: ModelStringMap;
  instructionFile: string | null;
}
interface LoadedAgentInstruction {
  content: string | null;
  path: string | null;
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
      return {
        contextLengths: {},
        baseUrls: {},
        apiKeys: {},
        instructionFile: null,
      };
    }
    const instructionFileRaw = (parsed as Record<string, unknown>)
      .instruction_file;
    const instructionFile =
      typeof instructionFileRaw === "string" && instructionFileRaw.length > 0
        ? instructionFileRaw
        : null;

    const models = (parsed as Record<string, unknown>).models;
    if (
      typeof models !== "object" ||
      models === null ||
      Array.isArray(models)
    ) {
      return {
        contextLengths: {},
        baseUrls: {},
        apiKeys: {},
        instructionFile,
      };
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
    return { contextLengths, baseUrls, apiKeys, instructionFile };
  } catch {
    return {
      contextLengths: {},
      baseUrls: {},
      apiKeys: {},
      instructionFile: null,
    };
  }
}

function buildInstructionCandidates(
  cwd: string,
  instructionFile: string | null,
): string[] {
  const candidates: string[] = [];
  if (instructionFile) {
    candidates.push(resolve(cwd, instructionFile));
  }
  const defaultPath = resolve(cwd, DEFAULT_AGENT_INSTRUCTION_FILE);
  if (!candidates.includes(defaultPath)) {
    candidates.push(defaultPath);
  }
  return candidates;
}

function loadAgentInstruction(
  cwd: string,
  instructionFile: string | null,
): LoadedAgentInstruction {
  const candidates = buildInstructionCandidates(cwd, instructionFile);
  for (const candidate of candidates) {
    try {
      const content = readFileSync(candidate, "utf8").trim();
      if (content.length > 0) {
        return {
          content,
          path: candidate,
        };
      }
    } catch {
      // ignore candidate and continue to next fallback
    }
  }
  return {
    content: null,
    path: null,
  };
}

function mergeSystemPrompt(
  defaultSystemPrompt: string,
  agentInstructionContent: string | null,
): string {
  if (!agentInstructionContent) {
    return defaultSystemPrompt;
  }
  return `${defaultSystemPrompt}\n\n${agentInstructionContent}`;
}

export interface AppConfig extends RuntimeConfig {}

export function loadAppConfig(
  env: NodeJS.ProcessEnv,
  defaultSystemPrompt: string,
): AppConfig {
  const cwd = process.cwd();
  const model = env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const loaded = loadVibeModelConfig(cwd);
  const loadedInstruction =
    typeof env.SYSTEM_PROMPT === "string"
      ? { content: null, path: null }
      : loadAgentInstruction(cwd, loaded.instructionFile);
  const mergedSystemPrompt = mergeSystemPrompt(
    defaultSystemPrompt,
    loadedInstruction.content,
  );

  return {
    baseUrl: env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: env.OPENAI_API_KEY ?? DEFAULT_API_KEY,
    model,
    modelContextLengths: loaded.contextLengths,
    modelBaseUrls: loaded.baseUrls,
    modelApiKeys: loaded.apiKeys,
    systemPrompt: env.SYSTEM_PROMPT ?? mergedSystemPrompt,
    agentInstructionPath: loadedInstruction.path,
    maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
    maxPreviewChars: DEFAULT_MAX_PREVIEW_CHARS,
    enforceToolCallFirstRound: env.ENFORCE_TOOL_CALL_FIRST_ROUND !== "0",
    modelTokenLimit: loaded.contextLengths[model] ?? null,
    mentionMaxLines: DEFAULT_MENTION_MAX_LINES,
  };
}
