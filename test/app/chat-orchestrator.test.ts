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
  OpenAIUsage,
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

function usage(total: number): OpenAIUsage {
  return {
    prompt_tokens: Math.floor(total / 2),
    completion_tokens: total - Math.floor(total / 2),
    total_tokens: total,
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
          return {
            message: assistant({ content: "first", toolCalls: [] }),
            usage: usage(10),
          };
        }
        return {
          message: assistant({
            content: "retry",
            toolCalls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          }),
          usage: usage(20),
        };
      },
    };

    const result = await requestAssistantMessage({
      gateway,
      baseUrl: "http://localhost:1234/v1",
      apiKey: "key",
      model: "m",
      messages: [] as ChatMessage[],
      tools: [] as CompletionTool[],
      round: 0,
      enforceToolCallFirstRound: true,
    });

    expect(calls).toEqual(["auto", "required"]);
    expect(result.retriedWithRequired).toBe(true);
    expect(result.message).not.toBeNull();
    expect(getToolCalls(result.message as AssistantMessage)).toHaveLength(1);
    expect(result.usage?.total_tokens).toBe(30);
  });

  test("requestAssistantMessage does not retry when tools exist", async () => {
    const calls: string[] = [];
    const gateway: CompletionGateway = {
      async request({ toolChoice }) {
        calls.push(toolChoice);
        return {
          message: assistant({
            content: "ok",
            toolCalls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          }),
          usage: usage(12),
        };
      },
    };

    const result = await requestAssistantMessage({
      gateway,
      baseUrl: "http://localhost:1234/v1",
      apiKey: "key",
      model: "m",
      messages: [] as ChatMessage[],
      tools: [] as CompletionTool[],
      round: 0,
      enforceToolCallFirstRound: true,
    });

    expect(calls).toEqual(["auto"]);
    expect(result.retriedWithRequired).toBe(false);
    expect(result.message).not.toBeNull();
    expect(getAssistantContent(result.message as AssistantMessage)).toBe("ok");
    expect(result.usage?.total_tokens).toBe(12);
  });

  test("requestAssistantMessage returns null message when gateway has no message", async () => {
    const gateway: CompletionGateway = {
      async request() {
        return { message: null, usage: null };
      },
    };

    const result = await requestAssistantMessage({
      gateway,
      baseUrl: "http://localhost:1234/v1",
      apiKey: "key",
      model: "m",
      messages: [] as ChatMessage[],
      tools: [] as CompletionTool[],
      round: 0,
      enforceToolCallFirstRound: true,
    });

    expect(result).toEqual({
      message: null,
      usage: null,
      retriedWithRequired: false,
    });
  });
});
