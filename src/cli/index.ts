import { runChatLoop } from "../app/run-chat-loop";
import { runExecTask } from "../app/run-exec-task";
import { parseCliArgs } from "./argv";
import { loadAppConfig, type AppConfig } from "../config/runtime-config";
import {
  initializeVibeConfig,
  resolveVibeConfigPath,
} from "../config/vibe-config";
import { buildDefaultSystemPrompt } from "../domain/policies";
import { createConsoleIO } from "../infra/console-io";
import { createOpenAICompletionGateway } from "../infra/openai-client";
import { createDefaultToolRuntime } from "../infra/tool-runtime";

async function readInstructionFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString();
  }
  return text.trim();
}

const io = createConsoleIO();
const parsed = parseCliArgs(process.argv.slice(2));
if (!parsed.ok) {
  io.writeError(parsed.error);
  process.exit(1);
}

if (parsed.mode === "init") {
  try {
    const configPath = initializeVibeConfig(
      process.cwd(),
      parsed.configFilePath,
    );
    io.writeStatus(`initialized config: ${configPath}`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.writeError(message);
    process.exit(1);
  }
}

const toolRuntime = createDefaultToolRuntime(process.cwd(), {
  configFilePath: parsed.configFilePath,
});
const defaultSystemPrompt = buildDefaultSystemPrompt(
  toolRuntime.getAllowedToolNames(),
  toolRuntime.getExecutionEnvironment?.(),
);
let config: AppConfig;
try {
  config = loadAppConfig(defaultSystemPrompt, {
    configFilePath: parsed.configFilePath,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  io.writeError(message);
  process.exit(1);
}
const completionGateway = createOpenAICompletionGateway();

if (parsed.mode === "chat") {
  await runChatLoop({
    config,
    completionGateway,
    toolRuntime,
    io,
    onExit: () => {
      process.exit(0);
    },
  });
} else {
  const joinedInstruction = parsed.instructionArgs.join(" ").trim();
  const stdinInstruction =
    joinedInstruction.length > 0 ? "" : await readInstructionFromStdin();
  const instruction =
    joinedInstruction.length > 0 ? joinedInstruction : stdinInstruction;

  if (instruction.length === 0) {
    io.writeError("exec requires instruction text. Pass as args or via stdin.");
    process.exit(1);
  }

  const resolvedConfigPath = resolveVibeConfigPath(
    process.cwd(),
    parsed.configFilePath,
  );
  io.writeStatus(`[exec] config_file=${resolvedConfigPath}`);
  io.writeStatus(
    `[exec] instruction_file=${config.agentInstructionPath ?? "N/A"}`,
  );

  try {
    const result = await runExecTask({
      instruction,
      config,
      completionGateway,
      toolRuntime,
      io,
    });
    if (!result.success) {
      process.exit(result.exitCode);
    }
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.writeError(`exec failed: ${message}`);
    process.exit(1);
  }
}
