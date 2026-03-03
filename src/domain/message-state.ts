import type { ChatMessage, ToolCall } from "./types";

export function withUserMessage(
  messages: ChatMessage[],
  userInput: string,
): ChatMessage[] {
  return [...messages, { role: "user", content: userInput }];
}

export function withAssistantFinalMessage(
  messages: ChatMessage[],
  content: string,
): ChatMessage[] {
  return [...messages, { role: "assistant", content }];
}

export function withAssistantToolCalls(
  messages: ChatMessage[],
  content: string,
  toolCalls: ToolCall[],
): ChatMessage[] {
  return [
    ...messages,
    {
      role: "assistant",
      content,
      tool_calls: toolCalls,
    },
  ];
}

export function withToolResult(
  messages: ChatMessage[],
  toolCallId: string,
  content: unknown,
): ChatMessage[] {
  return [
    ...messages,
    {
      role: "tool",
      tool_call_id: toolCallId,
      content: JSON.stringify(content),
    },
  ];
}
