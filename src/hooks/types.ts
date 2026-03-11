import type {
  HookConfigEntry,
  HookPhase,
  RuntimeConfig,
} from "../domain/types";
import type { WorkflowGateState } from "../domain/workflow-gate";

export type HookMode = "chat" | "exec";

export interface HookArtifacts {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface HookResult {
  kind: "continue" | "warn" | "fail" | "block_finalize";
  artifacts?: HookArtifacts;
}

export interface HookEvent {
  name:
    | "run.started"
    | "run.completed"
    | "run.failed"
    | "session.started"
    | "session.loaded"
    | "session.reset"
    | "session.state.changed"
    | "message.appended"
    | "model.requested"
    | "model.responded"
    | "tool.call.started"
    | "tool.call.completed"
    | "slash.executed"
    | "phase.entered"
    | "phase.check";
  mode: HookMode;
  phase?: HookPhase;
  timestamp: string;
  payload?: Record<string, unknown>;
}

export interface HookInitContext {
  hookName: string;
  workspaceRoot: string;
  hookRoot: string;
  config: Record<string, unknown>;
  modeCapabilities: {
    mode: HookMode;
    supportsSessionPersistence: boolean;
  };
}

export interface HookContext {
  config: RuntimeConfig;
  mode: HookMode;
  workflowGate: WorkflowGateState;
  sessionId: string | null;
  sessionPath: string | null;
}

export interface HookModule {
  handle(
    event: HookEvent,
    context: HookContext,
  ): Promise<HookResult | undefined> | HookResult | undefined;
  recordHookResult?(
    params: {
      event: HookEvent;
      hookName: string;
      source: "built-in" | "public";
      result: HookResult;
    },
    context: HookContext,
  ): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export type HookFactory = (
  context: HookInitContext,
) => HookModule | Promise<HookModule>;

export interface RegisteredHook {
  hookName: string;
  source: "built-in" | "public";
  onError: HookConfigEntry["onError"];
  phases: HookConfigEntry["phases"];
  module: HookModule;
}

export interface HookDispatchResult {
  hookName: string;
  source: "built-in" | "public";
  result: HookResult;
}
