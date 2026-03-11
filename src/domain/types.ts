import OpenAI from "openai";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type AssistantMessage = OpenAI.Chat.Completions.ChatCompletionMessage;
export type CompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;
export type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
export type OpenAIUsage = OpenAI.CompletionUsage;

export interface CompletionResult {
  message: AssistantMessage | null;
  usage: OpenAIUsage | null;
}

export interface ReadUserInputResult {
  value: string;
  mentionedPaths: string[];
}

export interface SlashCommand {
  name: string;
  description?: string;
  callback?: (args: string[], rawInput: string) => void | Promise<void>;
}

export interface ReadUserInputOptions {
  commands?: SlashCommand[];
}

export interface TokenStatusSnapshot {
  model: string;
  baseUrl: string;
  lastUsage: OpenAIUsage | null;
  cumulativeUsage: OpenAIUsage;
  tokenLimit: number | null;
}

export interface RuntimeConfig {
  workspaceRoot: string;
  configDirectory: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelContextLengths: Record<string, number>;
  modelBaseUrls: Record<string, string>;
  modelApiKeys: Record<string, string>;
  systemPrompt: string;
  agentInstructionPath: string | null;
  maxToolRounds: number;
  maxPreviewChars: number;
  enforceToolCallFirstRound: boolean;
  modelTokenLimit: number | null;
  mentionMaxLines: number;
  chatWorkflowGateEnabled: boolean;
  hooks: HookConfigEntry[];
}

export type HookPhase = "analyze" | "execute" | "verify" | "done";

export interface HookPhaseFilter {
  analyze?: boolean;
  execute?: boolean;
  verify?: boolean;
  done?: boolean;
}

export interface HookConfigEntry {
  hookName: string;
  onError: "warn" | "abort";
  phases: HookPhaseFilter | null;
  config: Record<string, unknown>;
}

export interface CompletionGateway {
  request(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: ChatMessage[];
    tools: CompletionTool[];
    toolChoice: "auto" | "required";
  }): Promise<CompletionResult>;
}

export interface ToolRuntime {
  getAllowedTools(): CompletionTool[];
  getAllowedToolNames(): string[];
  getExecutionEnvironment?(): {
    platform: NodeJS.Platform;
    osRelease: string;
    shell: string;
  };
  getSecuritySummary?(): {
    writeScope: "read-only" | "workspace-write" | "unrestricted";
    defaultPolicy: "allow" | "deny";
    explicitDenyTools: string[];
  };
  invoke(
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      securityBypass?: boolean;
    },
  ): Promise<Record<string, unknown>>;
}

export interface ConsoleIO {
  readUserInput(
    prompt: string,
    options?: ReadUserInputOptions,
  ): Promise<ReadUserInputResult>;
  selectModel(models: string[], currentModel: string): Promise<string>;
  selectSecurityBypass(
    toolName: string,
    errorMessage: string,
  ): Promise<boolean>;
  runWithSpinner<T>(message: string, task: () => Promise<T>): Promise<T>;
  updateTokenStatus(snapshot: TokenStatusSnapshot): void;
  resetSessionUiState(): void;
  writeStatus(message: string): void;
  writeToolCall(name: string, args?: unknown): void;
  writeOutput(message: string): void;
  writeError(message: string): void;
}

export type ToolFailureReason =
  | "invalid_arguments_json"
  | "tool_not_available"
  | "tool_invoke_error"
  | "security_bypass_declined";

export interface ToolFailure {
  status: "failure";
  reason: ToolFailureReason;
  message: string;
}
