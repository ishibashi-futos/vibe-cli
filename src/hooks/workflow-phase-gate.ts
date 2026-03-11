import { buildWorkflowFinalContinuationMessage } from "../domain/workflow-gate";
import type { HookModule } from "./types";

export function createWorkflowPhaseGateHook(): HookModule {
  return {
    handle(event, context) {
      if (event.name !== "phase.check") {
        return { kind: "continue" };
      }

      const continuation = buildWorkflowFinalContinuationMessage(
        context.workflowGate,
      );
      if (!continuation) {
        return { kind: "continue" };
      }

      if (event.phase === "done") {
        return {
          kind: "block_finalize",
          artifacts: {
            summary: continuation,
          },
        };
      }

      if (event.phase === "verify") {
        return {
          kind: "fail",
          artifacts: {
            summary: continuation,
          },
        };
      }

      return { kind: "continue" };
    },
  };
}
