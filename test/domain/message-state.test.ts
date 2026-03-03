import { describe, expect, test } from "bun:test";
import {
  withAssistantFinalMessage,
  withAssistantToolCalls,
  withToolResult,
  withUserMessage,
} from "../../src/domain/message-state";
import type { ChatMessage, ToolCall } from "../../src/domain/types";

describe("message-state", () => {
  test("withUserMessage appends user message", () => {
    const base: ChatMessage[] = [{ role: "system", content: "sys" }];
    const next = withUserMessage(base, "hello");

    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ role: "user", content: "hello" });
    expect(base).toHaveLength(1);
  });

  test("withAssistantFinalMessage appends assistant text", () => {
    const base: ChatMessage[] = [{ role: "system", content: "sys" }];
    const next = withAssistantFinalMessage(base, "done");

    expect(next[1]).toEqual({ role: "assistant", content: "done" });
  });

  test("withAssistantToolCalls appends tool call payload", () => {
    const toolCall: ToolCall = {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    };
    const next = withAssistantToolCalls([], "", [toolCall]);

    expect(next[0]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [toolCall],
    });
  });

  test("withToolResult appends tool response as JSON string", () => {
    const next = withToolResult([], "call_1", { ok: true });

    expect(next[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify({ ok: true }),
    });
  });
});
