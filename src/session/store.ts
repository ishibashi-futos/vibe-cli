import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ChatMessage,
  LoadedSession,
  OpenAIUsage,
  SessionEvent,
  SessionHookEvent,
  SessionMeta,
  SessionStateSnapshot,
  SessionSummary,
} from "../domain/types";

const SESSION_SCHEMA_VERSION = 1;

function toLocalTimestampPart(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}${second}`;
}

function cloneUsage(usage: OpenAIUsage | null): OpenAIUsage | null {
  if (!usage) {
    return null;
  }

  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };
}

function createDefaultState(model: string): SessionStateSnapshot {
  return {
    currentModel: model,
    workflowGateEnabled: true,
    lastUsage: null,
    cumulativeUsage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatMessage(value: unknown): value is ChatMessage {
  return isRecord(value) && typeof value.role === "string";
}

function hasToolCalls(message: ChatMessage): message is ChatMessage & {
  role: "assistant";
  tool_calls: Array<{ id?: string | null }>;
} {
  return (
    message.role === "assistant" &&
    "tool_calls" in message &&
    Array.isArray(message.tool_calls)
  );
}

function isToolMessage(message: ChatMessage): message is ChatMessage & {
  role: "tool";
  tool_call_id?: string;
} {
  return message.role === "tool" && "tool_call_id" in message;
}

function readUsage(value: unknown): OpenAIUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  const prompt = value.prompt_tokens;
  const completion = value.completion_tokens;
  const total = value.total_tokens;
  if (
    typeof prompt !== "number" ||
    typeof completion !== "number" ||
    typeof total !== "number"
  ) {
    return null;
  }

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

function readSessionState(value: unknown): SessionStateSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.currentModel !== "string" ||
    typeof value.workflowGateEnabled !== "boolean"
  ) {
    return null;
  }

  return {
    currentModel: value.currentModel,
    workflowGateEnabled: value.workflowGateEnabled,
    lastUsage: readUsage(value.lastUsage),
    cumulativeUsage:
      readUsage(value.cumulativeUsage) ??
      createDefaultState(value.currentModel).cumulativeUsage,
  };
}

function trimIncompleteToolCallTail(messages: ChatMessage[]): ChatMessage[] {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || !hasToolCalls(message)) {
      continue;
    }

    if (message.tool_calls.length === 0) {
      continue;
    }

    const pendingIds = new Set(
      message.tool_calls
        .map((toolCall: { id?: string | null }) => toolCall?.id)
        .filter(
          (toolCallId: string | null | undefined): toolCallId is string =>
            typeof toolCallId === "string",
        ),
    );

    let cursor = index + 1;
    while (pendingIds.size > 0 && cursor < messages.length) {
      const candidate = messages[cursor];
      if (!candidate || !isToolMessage(candidate)) {
        break;
      }
      if (
        typeof candidate.tool_call_id === "string" &&
        pendingIds.has(candidate.tool_call_id)
      ) {
        pendingIds.delete(candidate.tool_call_id);
      }
      cursor += 1;
    }

    if (pendingIds.size > 0) {
      return messages.slice(0, index);
    }
  }

  return messages;
}

function readSessionEvents(path: string): SessionEvent[] {
  const raw = readFileSync(path, "utf8");
  if (raw.trim().length === 0) {
    return [];
  }

  const lines = raw.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const events: SessionEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.trim().length === 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as SessionEvent;
      events.push(parsed);
    } catch (error) {
      if (index === lines.length - 1) {
        break;
      }
      throw new Error(
        `failed to parse session event in ${path}:${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return events;
}

function firstUserPreview(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) {
    return "";
  }

  const content = firstUser.content;
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        isRecord(part) && typeof part.text === "string" ? part.text : "",
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 80);
  }

  return "";
}

export function getSessionDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, ".agents", "sessions");
}

export function createSessionFilePath(params: {
  workspaceRoot: string;
  sessionId: string;
  now?: Date;
}): string {
  const sessionDirectory = getSessionDirectory(params.workspaceRoot);
  const now = params.now ?? new Date();
  return join(
    sessionDirectory,
    `${toLocalTimestampPart(now)}-${params.sessionId}.jsonl`,
  );
}

export function ensureSessionDirectory(workspaceRoot: string): string {
  const sessionDirectory = getSessionDirectory(workspaceRoot);
  mkdirSync(sessionDirectory, { recursive: true });
  return sessionDirectory;
}

export function appendSessionEvent(path: string, event: SessionEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function initializeSessionLog(params: {
  path: string;
  sessionId: string;
  workspaceRoot: string;
  configFilePath: string | null;
  createdAt?: string;
}): SessionMeta {
  const createdAt = params.createdAt ?? new Date().toISOString();
  const meta: SessionMeta = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: params.sessionId,
    createdAt,
    workspaceRoot: params.workspaceRoot,
    configFilePath: params.configFilePath,
    mode: "chat",
    path: params.path,
  };
  ensureSessionDirectory(params.workspaceRoot);
  writeFileSync(
    params.path,
    `${JSON.stringify({
      type: "session_meta",
      timestamp: createdAt,
      schemaVersion: meta.schemaVersion,
      sessionId: meta.sessionId,
      createdAt: meta.createdAt,
      workspaceRoot: meta.workspaceRoot,
      configFilePath: meta.configFilePath,
      mode: meta.mode,
    } satisfies SessionEvent)}\n`,
    "utf8",
  );
  return meta;
}

export function loadSession(path: string): LoadedSession {
  const events = readSessionEvents(path);
  let meta: SessionMeta | null = null;
  let state: SessionStateSnapshot | null = null;
  const messages: ChatMessage[] = [];
  const hookEvents: SessionHookEvent[] = [];

  for (const event of events) {
    if (event.type === "session_meta") {
      meta = {
        schemaVersion: event.schemaVersion,
        sessionId: event.sessionId,
        createdAt: event.createdAt,
        workspaceRoot: event.workspaceRoot,
        configFilePath: event.configFilePath,
        mode: event.mode,
        path,
      };
      continue;
    }

    if (event.type === "session_state") {
      const parsedState = readSessionState(event.state);
      if (parsedState) {
        state = parsedState;
      }
      continue;
    }

    if (event.type === "message" && isChatMessage(event.message)) {
      messages.push(event.message);
      continue;
    }

    if (event.type === "hook_event") {
      hookEvents.push(event);
    }
  }

  if (!meta) {
    throw new Error(`missing session_meta in ${path}`);
  }

  const trimmedMessages = trimIncompleteToolCallTail(messages);
  const effectiveState = state ?? createDefaultState("unknown");

  return {
    ...meta,
    path,
    state: effectiveState,
    messages: trimmedMessages,
    hookEvents,
  };
}

export function listSessionSummaries(workspaceRoot: string): SessionSummary[] {
  const sessionDirectory = getSessionDirectory(workspaceRoot);
  if (!existsSync(sessionDirectory)) {
    return [];
  }

  const files = readdirSync(sessionDirectory)
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => join(sessionDirectory, entry));

  return files
    .map((path) => {
      const events = readSessionEvents(path);
      const loaded = loadSession(path);
      const fileStat = statSync(path);
      const updatedAt =
        events.at(-1)?.timestamp ?? fileStat.mtime.toISOString();
      return {
        sessionId: loaded.sessionId,
        path,
        basename: basename(path),
        updatedAt,
        model: loaded.state.currentModel,
        firstUserMessagePreview: firstUserPreview(loaded.messages),
      } satisfies SessionSummary;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function resolveSessionSelector(params: {
  workspaceRoot: string;
  selector: string;
}): string {
  const selector = params.selector.trim();
  if (selector.length === 0) {
    throw new Error("session selector is empty");
  }

  const sessionDirectory = getSessionDirectory(params.workspaceRoot);
  const summaries = listSessionSummaries(params.workspaceRoot);
  const byPathCandidate = isAbsolute(selector)
    ? selector
    : resolve(params.workspaceRoot, selector);
  if (existsSync(byPathCandidate)) {
    return byPathCandidate;
  }

  const matches = summaries.filter((summary) => {
    if (summary.basename === selector) {
      return true;
    }
    if (summary.basename.replace(/\.jsonl$/, "") === selector) {
      return true;
    }
    return summary.sessionId.endsWith(selector);
  });

  if (matches.length === 1) {
    return matches[0]?.path ?? "";
  }

  if (matches.length > 1) {
    throw new Error(`multiple sessions match selector: ${selector}`);
  }

  throw new Error(`session not found: ${selector} (${sessionDirectory})`);
}
