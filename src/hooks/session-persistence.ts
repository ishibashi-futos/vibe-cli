import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HookInitContext, HookModule } from "./types";

function isTestRuntime(): boolean {
  if (process.env.NODE_ENV === "test") {
    return true;
  }

  const bunArgv = globalThis.Bun?.argv;
  return Array.isArray(bunArgv) && bunArgv[1] === "test";
}

export function createSessionPersistenceHook(
  initContext: HookInitContext,
): HookModule {
  const sessionDirectory = join(
    initContext.workspaceRoot,
    ".agents",
    "sessions",
  );
  const sessionLogPath = join(sessionDirectory, "current.jsonl");
  let storageReady = false;
  let storageError: string | null = null;

  return {
    handle(event, context) {
      if (context.mode !== "chat") {
        return { kind: "continue" };
      }

      if (isTestRuntime()) {
        return { kind: "continue" };
      }

      if (!storageReady && !storageError) {
        try {
          mkdirSync(sessionDirectory, { recursive: true });
          storageReady = true;
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
      }

      if (storageError) {
        return { kind: "continue" };
      }

      const record = {
        timestamp: event.timestamp,
        sessionId: context.sessionId,
        mode: context.mode,
        name: event.name,
        phase: event.phase ?? null,
        payload: event.payload ?? null,
      };
      try {
        appendFileSync(sessionLogPath, `${JSON.stringify(record)}\n`, "utf8");
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
      return { kind: "continue" };
    },
  };
}
