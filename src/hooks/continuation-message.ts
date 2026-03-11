import type { HookDispatchResult } from "./types";

function toSingleLineSummary(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildHookContinuationMessage(
  decision: HookDispatchResult,
): string {
  const lines = [`Hook gate blocked finalization: ${decision.hookName}`];
  const summary = toSingleLineSummary(decision.result.artifacts?.summary);
  const stdout = toSingleLineSummary(decision.result.artifacts?.stdout);
  const stderr = toSingleLineSummary(decision.result.artifacts?.stderr);

  if (summary) {
    lines.push(summary);
  }
  if (stdout) {
    lines.push(`stdout: ${stdout}`);
  }
  if (stderr) {
    lines.push(`stderr: ${stderr}`);
  }

  lines.push(
    "Continue with self-repair and verification before attempting to finalize again.",
  );
  return lines.join("\n");
}
