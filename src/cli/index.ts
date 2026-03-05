import { runChatLoop } from "../app/run-chat-loop";
import { loadAppConfig } from "../config/runtime-config";
import { buildDefaultSystemPrompt } from "../domain/policies";
import { createConsoleIO } from "../infra/console-io";
import { createOpenAICompletionGateway } from "../infra/openai-client";
import { createDefaultToolRuntime } from "../infra/tool-runtime";

const toolRuntime = createDefaultToolRuntime(process.cwd());
const defaultSystemPrompt = buildDefaultSystemPrompt(
  toolRuntime.getAllowedToolNames(),
);
const config = loadAppConfig(process.env, defaultSystemPrompt);

await runChatLoop({
  config,
  completionGateway: createOpenAICompletionGateway(),
  toolRuntime,
  io: createConsoleIO(),
});
