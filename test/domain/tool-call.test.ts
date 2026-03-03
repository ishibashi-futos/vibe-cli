import { describe, expect, test } from "bun:test";
import {
  buildToolFailure,
  buildToolUnavailableMessage,
  isToolAvailable,
  parseToolArgs,
} from "../../src/domain/tool-call";

describe("tool-call", () => {
  test("parseToolArgs parses object JSON", () => {
    const result = parseToolArgs('{"path":"README.md"}');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toBe("README.md");
    }
  });

  test("parseToolArgs rejects non-object JSON", () => {
    const result = parseToolArgs("[1,2,3]");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("JSON object");
    }
  });

  test("parseToolArgs returns parser error", () => {
    const result = parseToolArgs("{");

    expect(result.ok).toBe(false);
  });

  test("isToolAvailable checks set membership", () => {
    const available = new Set(["read_file", "apply_patch"]);
    expect(isToolAvailable("read_file", available)).toBe(true);
    expect(isToolAvailable("exec_command", available)).toBe(false);
  });

  test("buildToolUnavailableMessage includes available tools", () => {
    const msg = buildToolUnavailableMessage("x", ["a", "b"]);
    expect(msg).toContain("Tool 'x' is not available");
    expect(msg).toContain("a, b");
  });

  test("buildToolFailure formats failure payload", () => {
    expect(buildToolFailure("tool_invoke_error", "boom")).toEqual({
      status: "failure",
      reason: "tool_invoke_error",
      message: "boom",
    });
  });
});
