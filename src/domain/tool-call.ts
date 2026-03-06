import type { ToolFailure, ToolFailureReason } from "./types";

export type ParseToolArgsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseToolArgs(argumentsText: string): ParseToolArgsResult {
  try {
    const parsed = JSON.parse(argumentsText || "{}");

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false, error: "Tool arguments must be a JSON object." };
    }

    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildToolFailure(
  reason: ToolFailureReason,
  message: string,
): ToolFailure {
  return {
    status: "failure",
    reason,
    message,
  };
}

export function isToolAvailable(
  toolName: string,
  availableToolSet: ReadonlySet<string>,
): boolean {
  return availableToolSet.has(toolName);
}

export function buildToolUnavailableMessage(
  toolName: string,
  availableToolNames: string[],
): string {
  return `Tool '${toolName}' is not available. Available tools: ${availableToolNames.join(", ")}`;
}

function hasToolNotAllowedCode(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return "code" in value && value.code === "TOOL_NOT_ALLOWED";
}

export function isSecurityRestrictedInvokeError(error: unknown): boolean {
  if (hasToolNotAllowedCode(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("TOOL_NOT_ALLOWED");
}

export function buildSecurityBypassDeclinedMessage(toolName: string): string {
  return `SecurityBypass declined by user for tool: ${toolName}`;
}
