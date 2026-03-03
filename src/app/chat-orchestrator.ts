import type {
  AssistantMessage,
  ChatMessage,
  CompletionGateway,
  CompletionTool,
  ToolCall,
} from "../domain/types";

export function getToolCalls(message: AssistantMessage): ToolCall[] {
  return message.tool_calls ?? [];
}

export function getAssistantContent(message: AssistantMessage): string {
  return message.content ?? "";
}

export function shouldRetryWithRequiredToolChoice(params: {
  enforceToolCallFirstRound: boolean;
  round: number;
  toolCalls: ToolCall[];
}): boolean {
  const { enforceToolCallFirstRound, round, toolCalls } = params;
  return enforceToolCallFirstRound && round === 0 && toolCalls.length === 0;
}

export async function requestAssistantMessage(params: {
  gateway: CompletionGateway;
  model: string;
  messages: ChatMessage[];
  tools: CompletionTool[];
  round: number;
  enforceToolCallFirstRound: boolean;
}): Promise<{
  message: AssistantMessage | null;
  retriedWithRequired: boolean;
}> {
  const { gateway, model, messages, tools, round, enforceToolCallFirstRound } =
    params;

  const first = await gateway.request({
    model,
    messages,
    tools,
    toolChoice: "auto",
  });

  if (!first) {
    return { message: null, retriedWithRequired: false };
  }

  const firstToolCalls = getToolCalls(first);

  if (
    !shouldRetryWithRequiredToolChoice({
      enforceToolCallFirstRound,
      round,
      toolCalls: firstToolCalls,
    })
  ) {
    return { message: first, retriedWithRequired: false };
  }

  const retry = await gateway.request({
    model,
    messages,
    tools,
    toolChoice: "required",
  });

  return { message: retry, retriedWithRequired: true };
}
