import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_CONFIG_RELATIVE_PATH = ".agents/vibe-config.json";
const DEFAULT_AGENT_INSTRUCTION_FILE = "AGENTS.md";

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
