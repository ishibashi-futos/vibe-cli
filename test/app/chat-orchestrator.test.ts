import { describe, expect, test } from "bun:test";
import {
  getAssistantContent,
  getToolCalls,
  requestAssistantMessage,
  shouldRetryWithRequiredToolChoice,
} from "../../src/app/chat-orchestrator";
import type {
  AssistantMessage,
  ChatMessage,
  CompletionGateway,
  CompletionTool,
} from "../../src/domain/types";

function assistant(
  params: {
    content?: string | null;
    toolCalls?: AssistantMessage["tool_calls"];
  } = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: params.content ?? "",
    tool_calls: params.toolCalls,
    refusal: null,
  };
}

describe("chat-orchestrator", () => {
  test("shouldRetryWithRequiredToolChoice is true only at first round with no tools", () => {
    expect(
      shouldRetryWithRequiredToolChoice({
        enforceToolCallFirstRound: true,
        round: 0,
        toolCalls: [],
      }),
    ).toBe(true);

    expect(
      shouldRetryWithRequiredToolChoice({
        enforceToolCallFirstRound: true,
        round: 1,
        toolCalls: [],
      }),
    ).toBe(false);
  });

  test("requestAssistantMessage retries with required when first round has no tools", async () => {
    const calls: string[] = [];
    const gateway: CompletionGateway = {
      async request({ toolChoice }) {
        calls.push(toolChoice);
        if (toolChoice === "auto") {
          return assistant({ content: "first", toolCalls: [] });
        }
        return assistant({
          content: "retry",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        });
      },
    };

    const result = await requestAssistantMessage({
      gateway,
      model: "m",
      messages: [] as ChatMessage[],
      tools: [] as CompletionTool[],
      round: 0,
      enforceToolCallFirstRound: true,
    });

    expect(calls).toEqual(["auto", "required"]);
    expect(result.retriedWithRequired).toBe(true);
    expect(getToolCalls(result.message!)).toHaveLength(1);
  });

  test("requestAssistantMessage does not retry when tools exist", async () => {
    const calls: string[] = [];
    const gateway: CompletionGateway = {
      async request({ toolChoice }) {
        calls.push(toolChoice);
        return assistant({
          content: "ok",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        });
      },
    };

    const result = await requestAssistantMessage({
      gateway,
      model: "m",
      messages: [] as ChatMessage[],
      tools: [] as CompletionTool[],
      round: 0,
      enforceToolCallFirstRound: true,
    });

    expect(calls).toEqual(["auto"]);
    expect(result.retriedWithRequired).toBe(false);
    expect(getAssistantContent(result.message!)).toBe("ok");
  });

  test("requestAssistantMessage returns null if gateway returns null", async () => {
    const gateway: CompletionGateway = {
      async request() {
        return null;
      },
    };

    const result = await requestAssistantMessage({
      gateway,
      model: "m",
      messages: [] as ChatMessage[],
      tools: [] as CompletionTool[],
      round: 0,
      enforceToolCallFirstRound: true,
    });

    expect(result).toEqual({ message: null, retriedWithRequired: false });
  });
});
