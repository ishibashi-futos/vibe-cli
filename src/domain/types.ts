import OpenAI from "openai";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type AssistantMessage = OpenAI.Chat.Completions.ChatCompletionMessage;
export type CompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;
export type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

export interface RuntimeConfig {
  model: string;
  systemPrompt: string;
  maxToolRounds: number;
  maxPreviewChars: number;
  enforceToolCallFirstRound: boolean;
}

export interface CompletionGateway {
  request(params: {
    model: string;
    messages: ChatMessage[];
    tools: CompletionTool[];
    toolChoice: "auto" | "required";
  }): Promise<AssistantMessage | null>;
}

export interface ToolRuntime {
  getAllowedTools(): CompletionTool[];
  getAllowedToolNames(): string[];
  invoke(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export interface ConsoleIO {
  readUserInput(prompt: string): Promise<string>;
  writeLine(message: string): void;
  writeError(message: string): void;
}

export type ToolFailureReason =
  | "invalid_arguments_json"
  | "tool_not_available"
  | "tool_invoke_error";

export interface ToolFailure {
  status: "failure";
  reason: ToolFailureReason;
  message: string;
}
