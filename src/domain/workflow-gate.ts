import { buildToolFailure } from "./tool-call";
import type { ToolFailure } from "./types";

const ANALYSIS_TOOL_NAMES = new Set([
  "regexp_search",
  "ast_grep_search",
  "tree",
  "git_status_summary",
]);
const INTERNAL_TASK_TOOL_NAMES = new Set([
  "task_create_many",
  "task_list",
  "task_update",
  "task_update_status",
  "task_validate_completion",
]);
const MUTATION_TOOL_NAMES = new Set(["apply_patch", "write_file"]);

export interface WorkflowGateState {
  activated: boolean;
  analysisAvailable: boolean;
  analysisSeen: boolean;
  todoInitialized: boolean;
  todoValidated: boolean;
  remainingTaskIds: string[];
  mutationSeen: boolean;
  verifySeenAfterLastMutation: boolean;
  analysisReminderSent: boolean;
}

export function createWorkflowGate(params: {
  activated: boolean;
  availableToolNames: string[];
}): WorkflowGateState {
  const analysisAvailable = params.availableToolNames.some((toolName) =>
    ANALYSIS_TOOL_NAMES.has(toolName),
  );

  return {
    activated: params.activated,
    analysisAvailable,
    analysisSeen: false,
    todoInitialized: false,
    todoValidated: false,
    remainingTaskIds: [],
    mutationSeen: false,
    verifySeenAfterLastMutation: false,
    analysisReminderSent: false,
  };
}

export function activateWorkflowGate(state: WorkflowGateState): void {
  state.activated = true;
}

export function isInternalTaskTool(toolName: string): boolean {
  return INTERNAL_TASK_TOOL_NAMES.has(toolName);
}

export function shouldBlockToolExecution(
  state: WorkflowGateState,
  toolName: string,
): ToolFailure | null {
  if (!state.activated || !MUTATION_TOOL_NAMES.has(toolName)) {
    return null;
  }

  if (state.analysisAvailable && !state.analysisSeen) {
    return buildToolFailure(
      "tool_invoke_error",
      [
        "Workflow gate: codebase analysis has not been performed yet.",
        "Call at least one of regexp_search, ast_grep_search, tree, or git_status_summary before editing files.",
      ].join(" "),
    );
  }

  if (!state.todoInitialized) {
    return buildToolFailure(
      "tool_invoke_error",
      "Workflow gate: task list is not initialized. Call task_create_many before editing files.",
    );
  }

  return null;
}

export function recordWorkflowToolSuccess(
  state: WorkflowGateState,
  toolName: string,
  result: Record<string, unknown>,
): void {
  if (ANALYSIS_TOOL_NAMES.has(toolName)) {
    state.analysisSeen = true;
  }

  if (toolName === "task_create_many") {
    state.todoInitialized = true;
    state.todoValidated = false;
    state.remainingTaskIds = [];
    return;
  }

  if (toolName === "task_update" || toolName === "task_update_status") {
    state.todoValidated = false;
    state.remainingTaskIds = [];
    return;
  }

  if (toolName === "task_validate_completion") {
    state.todoInitialized = true;
    state.todoValidated = result.ok === true;
    state.remainingTaskIds = Array.isArray(result.remaining)
      ? result.remaining.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return;
  }

  if (MUTATION_TOOL_NAMES.has(toolName)) {
    state.mutationSeen = true;
    state.verifySeenAfterLastMutation = false;
    return;
  }

  if (toolName === "exec_command" && state.mutationSeen) {
    state.verifySeenAfterLastMutation = true;
  }
}

function getMissingWorkflowSteps(state: WorkflowGateState): string[] {
  const missing: string[] = [];

  if (state.analysisAvailable && !state.analysisSeen) {
    missing.push(
      "run at least one codebase analysis tool: regexp_search, ast_grep_search, tree, or git_status_summary",
    );
  }

  if (!state.todoInitialized) {
    missing.push("initialize the task list with task_create_many");
  }

  if (!state.todoValidated) {
    missing.push("validate task completion with task_validate_completion");
  }

  if (state.mutationSeen && !state.verifySeenAfterLastMutation) {
    missing.push(
      "run verification after the latest file mutation with exec_command",
    );
  }

  return missing;
}

export function buildWorkflowFinalContinuationMessage(
  state: WorkflowGateState,
): string | null {
  if (!state.activated) {
    return null;
  }

  const missing = getMissingWorkflowSteps(state);
  if (missing.length === 0) {
    return null;
  }

  const lines = ["Workflow gate: do not finalize yet."];

  if (state.analysisAvailable && !state.analysisSeen) {
    if (!state.analysisReminderSent) {
      lines.push(
        "No codebase analysis tool has been called in this run yet. Use regexp_search, ast_grep_search, tree, or git_status_summary before continuing.",
      );
      state.analysisReminderSent = true;
    } else {
      lines.push("Codebase analysis is still missing.");
    }
  }

  lines.push("Complete the following before finalizing:");
  for (const item of missing) {
    lines.push(`- ${item}`);
  }

  if (state.remainingTaskIds.length > 0) {
    lines.push(
      `Remaining task ids from task_validate_completion: ${state.remainingTaskIds.join(", ")}`,
    );
  }

  lines.push("Continue with tool calls instead of a final answer.");
  return lines.join("\n");
}
