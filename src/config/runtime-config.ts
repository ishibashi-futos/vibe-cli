import { readFileSync } from "node:fs";
import type { RuntimeConfig } from "../domain/types";
import {
  loadVibeConfigFile,
  resolveInstructionCandidates,
} from "./vibe-config";

const DEFAULT_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_API_KEY = "lmstudio";
const DEFAULT_MODEL = "qwen2.5-coder-7b-instruct-mlx";
const DEFAULT_MAX_TOOL_ROUNDS = 12;
const DEFAULT_MAX_PREVIEW_CHARS = 4000;
const DEFAULT_MENTION_MAX_LINES = 100;

type ModelTokenLimitMap = Record<string, number>;
type ModelStringMap = Record<string, string>;
interface LoadedVibeModelConfig {
  defaultModel: string | null;
  systemPrompt: string | null;
  maxToolRounds: number | null;
  maxPreviewChars: number | null;
  mentionMaxLines: number | null;
  enforceToolCallFirstRound: boolean | null;
  modelNames: string[];
  contextLengths: ModelTokenLimitMap;
  baseUrls: ModelStringMap;
  apiKeys: ModelStringMap;
  instructionFile: string | null;
  configDirectory: string;
}
interface LoadedAgentInstruction {
  content: string | null;
  path: string | null;
}

function readNonEmptyString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readPositiveInteger(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

function loadVibeModelConfig(
  cwd: string,
  configFilePath: string | null = null,
): LoadedVibeModelConfig {
  const loaded = loadVibeConfigFile(cwd, configFilePath);
  const parsed = loaded.parsed;
  if (!parsed) {
    return {
      defaultModel: null,
      systemPrompt: null,
      maxToolRounds: null,
      maxPreviewChars: null,
      mentionMaxLines: null,
      enforceToolCallFirstRound: null,
      modelNames: [],
      contextLengths: {},
      baseUrls: {},
      apiKeys: {},
      instructionFile: null,
      configDirectory: loaded.directory,
    };
  }

  const instructionFile = readNonEmptyString(parsed, "instruction_file");
  const defaultModel =
    readNonEmptyString(parsed, "default_model") ??
    readNonEmptyString(parsed, "model");
  const systemPrompt = readNonEmptyString(parsed, "system_prompt");
  const maxToolRounds = readPositiveInteger(parsed, "max_tool_rounds");
  const maxPreviewChars = readPositiveInteger(parsed, "max_preview_chars");
  const mentionMaxLines = readPositiveInteger(parsed, "mention_max_lines");
  const enforceToolCallFirstRound = readBoolean(
    parsed,
    "enforce_tool_call_first_round",
  );

  const models = parsed.models;
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    return {
      defaultModel,
      systemPrompt,
      maxToolRounds,
      maxPreviewChars,
      mentionMaxLines,
      enforceToolCallFirstRound,
      modelNames: [],
      contextLengths: {},
      baseUrls: {},
      apiKeys: {},
      instructionFile,
      configDirectory: loaded.directory,
    };
  }

  const contextLengths: ModelTokenLimitMap = {};
  const baseUrls: ModelStringMap = {};
  const apiKeys: ModelStringMap = {};
  const modelNames: string[] = [];
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

    modelNames.push(model);

    const contextLength = (definition as Record<string, unknown>)
      .context_length;
    if (
      typeof contextLength === "number" &&
      Number.isInteger(contextLength) &&
      contextLength > 0
    ) {
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
  return {
    defaultModel,
    systemPrompt,
    maxToolRounds,
    maxPreviewChars,
    mentionMaxLines,
    enforceToolCallFirstRound,
    modelNames,
    contextLengths,
    baseUrls,
    apiKeys,
    instructionFile,
    configDirectory: loaded.directory,
  };
}

function loadAgentInstruction(
  cwd: string,
  instructionFile: string | null,
  configDirectory: string,
): LoadedAgentInstruction {
  const candidates = resolveInstructionCandidates({
    workspaceRoot: cwd,
    configDirectory,
    instructionFile,
  });
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

function resolveConfiguredModel(loaded: LoadedVibeModelConfig): string {
  if (loaded.defaultModel !== null) {
    if (!loaded.modelNames.includes(loaded.defaultModel)) {
      throw new Error(
        `invalid .agents/vibe-config.json: default_model "${loaded.defaultModel}" is not defined under models`,
      );
    }
    return loaded.defaultModel;
  }

  return (
    loaded.modelNames[0] ??
    Object.keys(loaded.baseUrls)[0] ??
    Object.keys(loaded.apiKeys)[0] ??
    DEFAULT_MODEL
  );
}

export function loadAppConfig(
  defaultSystemPrompt: string,
  options: {
    configFilePath?: string | null;
  } = {},
): AppConfig {
  const cwd = process.cwd();
  const loaded = loadVibeModelConfig(cwd, options.configFilePath ?? null);
  const model = resolveConfiguredModel(loaded);
  const loadedInstruction =
    loaded.systemPrompt !== null
      ? { content: null, path: null }
      : loadAgentInstruction(
          cwd,
          loaded.instructionFile,
          loaded.configDirectory,
        );
  const mergedSystemPrompt = mergeSystemPrompt(
    defaultSystemPrompt,
    loadedInstruction.content,
  );

  return {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: DEFAULT_API_KEY,
    model,
    modelContextLengths: loaded.contextLengths,
    modelBaseUrls: loaded.baseUrls,
    modelApiKeys: loaded.apiKeys,
    systemPrompt: loaded.systemPrompt ?? mergedSystemPrompt,
    agentInstructionPath: loadedInstruction.path,
    maxToolRounds: loaded.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
    maxPreviewChars: loaded.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS,
    enforceToolCallFirstRound: loaded.enforceToolCallFirstRound ?? true,
    modelTokenLimit: loaded.contextLengths[model] ?? null,
    mentionMaxLines: loaded.mentionMaxLines ?? DEFAULT_MENTION_MAX_LINES,
  };
}
