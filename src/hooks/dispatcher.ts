import type { RuntimeConfig } from "../domain/types";
import { loadPublicHooks } from "./public-hook-loader";
import { createSessionPersistenceHook } from "./session-persistence";
import type {
  HookContext,
  HookDispatchResult,
  HookEvent,
  HookInitContext,
  HookMode,
  HookResult,
  RegisteredHook,
} from "./types";
import { createWorkflowPhaseGateHook } from "./workflow-phase-gate";

function shouldHandlePhase(
  phases: RegisteredHook["phases"],
  phase: HookEvent["phase"],
): boolean {
  if (!phases) {
    return true;
  }

  if (!phase) {
    return false;
  }

  return phases[phase] === true;
}

function normalizeHookResult(result: HookResult | void): HookResult {
  return result ?? { kind: "continue" };
}

export interface HookLogger {
  writeStatus(message: string): void;
  writeError(message: string): void;
}

export interface HookDispatcher {
  dispatch(event: Omit<HookEvent, "timestamp" | "mode">): Promise<{
    results: HookDispatchResult[];
    decision: HookDispatchResult | null;
  }>;
  dispose(): Promise<void>;
}

export async function createHookDispatcher(params: {
  config: RuntimeConfig;
  mode: HookMode;
  workflowGate: HookContext["workflowGate"];
  getSessionId: () => string | null;
  getSessionPath: () => string | null;
  logger: HookLogger;
}): Promise<HookDispatcher> {
  const initContext: HookInitContext = {
    hookName: "session-persistence",
    workspaceRoot: params.config.workspaceRoot,
    hookRoot: "",
    config: {},
    modeCapabilities: {
      mode: params.mode,
      supportsSessionPersistence: params.mode === "chat",
    },
  };
  const builtIns: RegisteredHook[] = [
    {
      hookName: "workflow-phase-gate",
      source: "built-in",
      onError: "abort",
      phases: null,
      module: createWorkflowPhaseGateHook(),
    },
  ];

  if (params.mode === "chat") {
    builtIns.unshift({
      hookName: "session-persistence",
      source: "built-in",
      onError: "warn",
      phases: null,
      module: createSessionPersistenceHook(initContext),
    });
  }

  const publicHooks = await loadPublicHooks({
    config: params.config,
    mode: params.mode,
  });
  const registeredHooks = [...builtIns, ...publicHooks];

  return {
    async dispatch(eventInput) {
      const event: HookEvent = {
        ...eventInput,
        mode: params.mode,
        timestamp: new Date().toISOString(),
      };
      const context: HookContext = {
        config: params.config,
        mode: params.mode,
        workflowGate: params.workflowGate,
        sessionId: params.getSessionId(),
        sessionPath: params.getSessionPath(),
      };
      const results: HookDispatchResult[] = [];

      for (const hook of registeredHooks) {
        if (!shouldHandlePhase(hook.phases, event.phase)) {
          continue;
        }

        try {
          const result = normalizeHookResult(
            await hook.module.handle(event, context),
          );
          results.push({
            hookName: hook.hookName,
            source: hook.source,
            result,
          });
          for (const recorder of registeredHooks) {
            await recorder.module.recordHookResult?.(
              {
                event,
                hookName: hook.hookName,
                source: hook.source,
                result,
              },
              context,
            );
          }

          if (result.kind === "warn" && result.artifacts?.summary) {
            params.logger.writeStatus(
              `[hook:${hook.hookName}] ${result.artifacts.summary}`,
            );
          }

          if (
            event.name === "phase.check" &&
            (result.kind === "fail" || result.kind === "block_finalize")
          ) {
            return {
              results,
              decision: results.at(-1) ?? null,
            };
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (hook.onError === "abort") {
            throw error;
          }

          params.logger.writeError(`[hook:${hook.hookName}] ${message}`);
          results.push({
            hookName: hook.hookName,
            source: hook.source,
            result: {
              kind: "warn",
              artifacts: {
                summary: message,
                stderr: message,
              },
            },
          });
        }
      }

      return { results, decision: null };
    },
    async dispose() {
      for (const hook of [...registeredHooks].reverse()) {
        await hook.module.dispose?.();
      }
    },
  };
}
