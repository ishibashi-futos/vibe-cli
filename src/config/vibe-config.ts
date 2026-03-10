import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_CONFIG_RELATIVE_PATH = ".agents/vibe-config.json";
const DEFAULT_AGENT_INSTRUCTION_FILE = "AGENTS.md";
const DEFAULT_CONFIG_TEMPLATE = {
  default_model: "model_name",
  max_tool_rounds: 12,
  max_preview_chars: 4000,
  mention_max_lines: 100,
  enforce_tool_call_first_round: true,
  tool_runtime: {
    write_scope: "workspace-write",
    policy: {
      default_policy: "deny",
      tools: {
        read_file: "allow",
        tree: "allow",
        regexp_search: "allow",
        ast_grep_search: "allow",
      },
    },
  },
  models: {
    model_name: {
      context_length: 32768,
      base_url: "http://localhost:1234/v1",
      api_key: "lmstudio",
    },
  },
};

interface LoadedVibeConfigFile {
  path: string;
  directory: string;
  parsed: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveVibeConfigPath(
  workspaceRoot: string,
  configFilePath: string | null = null,
): string {
  if (configFilePath && configFilePath.length > 0) {
    return isAbsolute(configFilePath)
      ? configFilePath
      : resolve(workspaceRoot, configFilePath);
  }

  return join(workspaceRoot, DEFAULT_CONFIG_RELATIVE_PATH);
}

export function loadVibeConfigFile(
  workspaceRoot: string,
  configFilePath: string | null = null,
): LoadedVibeConfigFile {
  const path = resolveVibeConfigPath(workspaceRoot, configFilePath);
  const directory = resolve(path, "..");

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return {
      path,
      directory,
      parsed: isRecord(parsed) ? parsed : null,
    };
  } catch {
    return {
      path,
      directory,
      parsed: null,
    };
  }
}

export function buildDefaultVibeConfigContent(): string {
  return `${JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2)}\n`;
}

export function initializeVibeConfig(
  workspaceRoot: string,
  configFilePath: string | null = null,
): string {
  const path = resolveVibeConfigPath(workspaceRoot, configFilePath);
  if (existsSync(path)) {
    throw new Error(`config file already exists: ${path}`);
  }

  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, buildDefaultVibeConfigContent(), "utf8");
  return path;
}

export function resolveInstructionCandidates(params: {
  workspaceRoot: string;
  configDirectory: string;
  instructionFile: string | null;
}): string[] {
  const { workspaceRoot, configDirectory, instructionFile } = params;
  const candidates: string[] = [];

  if (instructionFile && instructionFile.length > 0) {
    const configRelativeCandidate = isAbsolute(instructionFile)
      ? instructionFile
      : resolve(configDirectory, instructionFile);
    candidates.push(configRelativeCandidate);

    if (!isAbsolute(instructionFile)) {
      const workspaceRelativeCandidate = resolve(
        workspaceRoot,
        instructionFile,
      );
      if (!candidates.includes(workspaceRelativeCandidate)) {
        candidates.push(workspaceRelativeCandidate);
      }
    }
  }

  const workspaceFallback = resolve(
    workspaceRoot,
    DEFAULT_AGENT_INSTRUCTION_FILE,
  );
  if (!candidates.includes(workspaceFallback)) {
    candidates.push(workspaceFallback);
  }

  return candidates;
}

export function resolveConfigRelativeFileCandidates(params: {
  workspaceRoot: string;
  configDirectory: string;
  filePath: string | null;
}): string[] {
  const { workspaceRoot, configDirectory, filePath } = params;
  if (!filePath || filePath.length === 0) {
    return [];
  }

  const candidates: string[] = [];
  const configRelativeCandidate = isAbsolute(filePath)
    ? filePath
    : resolve(configDirectory, filePath);
  candidates.push(configRelativeCandidate);

  if (!isAbsolute(filePath)) {
    const workspaceRelativeCandidate = resolve(workspaceRoot, filePath);
    if (!candidates.includes(workspaceRelativeCandidate)) {
      candidates.push(workspaceRelativeCandidate);
    }
  }

  return candidates;
}
