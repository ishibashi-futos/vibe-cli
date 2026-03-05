import type {
  AssistantMessage,
  ChatMessage,
  CompletionGateway,
  CompletionTool,
  OpenAIUsage,
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

function mergeUsage(
  left: OpenAIUsage | null,
  right: OpenAIUsage | null,
): OpenAIUsage | null {
  if (!left && !right) {
    return null;
  }

  return {
    prompt_tokens: (left?.prompt_tokens ?? 0) + (right?.prompt_tokens ?? 0),
    completion_tokens:
      (left?.completion_tokens ?? 0) + (right?.completion_tokens ?? 0),
    total_tokens: (left?.total_tokens ?? 0) + (right?.total_tokens ?? 0),
  };
}

export async function requestAssistantMessage(params: {
  gateway: CompletionGateway;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: CompletionTool[];
  round: number;
  enforceToolCallFirstRound: boolean;
}): Promise<{
  message: AssistantMessage | null;
  usage: OpenAIUsage | null;
  retriedWithRequired: boolean;
}> {
  const {
    gateway,
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    round,
    enforceToolCallFirstRound,
  } = params;

  const first = await gateway.request({
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    toolChoice: "auto",
  });

  if (!first.message) {
    return { message: null, usage: first.usage, retriedWithRequired: false };
  }

  const firstToolCalls = getToolCalls(first.message);

  if (
    !shouldRetryWithRequiredToolChoice({
      enforceToolCallFirstRound,
      round,
      toolCalls: firstToolCalls,
    })
  ) {
    return {
      message: first.message,
      usage: first.usage,
      retriedWithRequired: false,
    };
  }

  const retry = await gateway.request({
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    toolChoice: "required",
  });

  return {
    message: retry.message,
    usage: mergeUsage(first.usage, retry.usage),
    retriedWithRequired: true,
  };
}
