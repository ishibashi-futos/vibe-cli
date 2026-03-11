import type {
  ChatMessage,
  SessionEvent,
  SessionStateSnapshot,
} from "../domain/types";
import { appendSessionEvent, initializeSessionLog } from "../session/store";
import type {
  HookContext,
  HookInitContext,
  HookModule,
  HookResult,
} from "./types";

const SESSION_PERSISTENCE_ENV = "VIBE_CLI_ENABLE_SESSION_PERSISTENCE";

function isTestRuntime(): boolean {
  if (process.env.NODE_ENV === "test") {
    return true;
  }

  const bunArgv = globalThis.Bun?.argv;
  return Array.isArray(bunArgv) && bunArgv[1] === "test";
}

function isSessionPersistenceEnabledInCurrentRuntime(): boolean {
  if (!isTestRuntime()) {
    return true;
  }

  return process.env[SESSION_PERSISTENCE_ENV] === "1";
}

function isChatMessage(value: unknown): value is ChatMessage {
  return typeof value === "object" && value !== null && "role" in value;
}

function readSessionPath(
  payload: Record<string, unknown> | undefined,
): string | null {
  return typeof payload?.sessionPath === "string" ? payload.sessionPath : null;
}

function readStateSnapshot(
  payload: Record<string, unknown> | undefined,
): SessionStateSnapshot | null {
  const state = payload?.state;
  if (typeof state !== "object" || state === null) {
    return null;
  }
  return state as SessionStateSnapshot;
}

function readMessage(
  payload: Record<string, unknown> | undefined,
): ChatMessage | null {
  const message = payload?.message;
  return isChatMessage(message) ? message : null;
}

function appendState(
  path: string,
  timestamp: string,
  state: SessionStateSnapshot,
): void {
  const event: SessionEvent = {
    type: "session_state",
    timestamp,
    state,
  };
  appendSessionEvent(path, event);
}

function appendMessage(
  path: string,
  timestamp: string,
  message: ChatMessage,
): void {
  const event: SessionEvent = {
    type: "message",
    timestamp,
    message,
  };
  appendSessionEvent(path, event);
}

export function createSessionPersistenceHook(
  _initContext: HookInitContext,
): HookModule {
  let storageError: string | null = null;

  const safelyWrite = (callback: () => void): HookResult => {
    if (storageError) {
      return { kind: "continue" };
    }

    try {
      callback();
      return { kind: "continue" };
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
      return {
        kind: "warn",
        artifacts: {
          summary: `session persistence disabled: ${storageError}`,
          stderr: storageError,
        },
      };
    }
  };

  return {
    handle(event, context) {
      if (context.mode !== "chat") {
        return { kind: "continue" };
      }

      if (!isSessionPersistenceEnabledInCurrentRuntime()) {
        return { kind: "continue" };
      }

      if (event.name === "session.started") {
        const payload = event.payload ?? {};
        const sessionPath = readSessionPath(payload);
        const state = readStateSnapshot(payload);
        const message = readMessage(payload);
        const sessionId =
          typeof payload.sessionId === "string"
            ? payload.sessionId
            : context.sessionId;
        if (!sessionPath || !sessionId || !state || !message) {
          return { kind: "continue" };
        }

        return safelyWrite(() => {
          initializeSessionLog({
            path: sessionPath,
            sessionId,
            workspaceRoot: context.config.workspaceRoot,
            configFilePath: context.config.configFilePath,
            createdAt: event.timestamp,
          });
          appendMessage(sessionPath, event.timestamp, message);
          appendState(sessionPath, event.timestamp, state);
        });
      }

      const sessionPath = context.sessionPath;
      if (!sessionPath) {
        return { kind: "continue" };
      }

      if (event.name === "session.loaded") {
        const state = readStateSnapshot(event.payload);
        if (!state) {
          return { kind: "continue" };
        }

        return safelyWrite(() => {
          appendState(sessionPath, event.timestamp, state);
        });
      }

      if (event.name === "session.state.changed") {
        const state = readStateSnapshot(event.payload);
        if (!state) {
          return { kind: "continue" };
        }

        return safelyWrite(() => {
          appendState(sessionPath, event.timestamp, state);
        });
      }

      if (event.name === "message.appended") {
        const message = readMessage(event.payload);
        if (!message) {
          return { kind: "continue" };
        }

        return safelyWrite(() => {
          appendMessage(sessionPath, event.timestamp, message);
        });
      }

      return { kind: "continue" };
    },
    recordHookResult(params, context) {
      if (
        context.mode !== "chat" ||
        !isSessionPersistenceEnabledInCurrentRuntime() ||
        !context.sessionPath ||
        params.result.kind === "continue" ||
        params.hookName === "session-persistence"
      ) {
        return;
      }

      if (storageError) {
        return;
      }

      try {
        appendSessionEvent(context.sessionPath, {
          type: "hook_event",
          timestamp: params.event.timestamp,
          phase: params.event.phase ?? null,
          hookName: params.hookName,
          resultKind: params.result.kind,
          summary: params.result.artifacts?.summary ?? null,
          artifacts: params.result.artifacts ?? null,
        });
      } catch (error) {
        storageError = error instanceof Error ? error.message : String(error);
      }
    },
  };
}
