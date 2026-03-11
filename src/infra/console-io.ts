import {
  createStickyStatusBar,
  HistoryManager,
  input,
  printError,
  printStatus,
  printToolCall,
  select,
  withSpinner,
} from "terminal-ui-kit";
import type {
  ConsoleIO,
  ReadUserInputOptions,
  TokenStatusSnapshot,
} from "../domain/types";

export function createConsoleIO(): ConsoleIO {
  let history = new HistoryManager();
  const stickyBar = createStickyStatusBar();
  let tokenStatus: TokenStatusSnapshot | null = null;

  const renderTokenText = () => {
    if (!tokenStatus) {
      return "";
    }

    const { model, lastUsage, cumulativeUsage, tokenLimit } = tokenStatus;
    const lastTotal = lastUsage?.total_tokens;
    const parts = [
      `model=${model}`,
      `last=${typeof lastTotal === "number" ? lastTotal : "N/A"}`,
      `total=${cumulativeUsage.total_tokens}`,
    ];

    if (typeof tokenLimit === "number") {
      const ratio = ((cumulativeUsage.total_tokens / tokenLimit) * 100).toFixed(
        1,
      );
      parts.push(`${ratio}%/${tokenLimit}`);
    }

    return parts.join(" ");
  };

  const writeRaw = (
    message: string,
    writer: Pick<typeof process.stdout, "write">,
  ) => {
    writer.write(`${message}\n`);
  };

  return {
    async readUserInput(prompt, options: ReadUserInputOptions = {}) {
      const result = await input(prompt, history, {
        commands: options.commands,
        stickyStatusBar: {
          bar: stickyBar,
          render: ({ buffer }) => {
            const tokenText = renderTokenText();
            const bufferText = `len=${buffer.length}`;
            if (tokenText.length === 0) {
              return bufferText;
            }
            return `${bufferText} | ${tokenText}`;
          },
        },
      });

      return {
        value: result.value,
        mentionedPaths: result.paths,
      };
    },
    runWithSpinner(message, task) {
      return withSpinner(message, task);
    },
    selectModel(models, currentModel) {
      return select(
        "Select model",
        models.map((model) => ({
          label: model === currentModel ? `${model} (current)` : model,
          value: model,
        })),
      );
    },
    selectSession(sessions, currentSessionId) {
      return select(
        "Resume session",
        sessions.map((session) => {
          const preview =
            session.firstUserMessagePreview.length > 0
              ? ` | ${session.firstUserMessagePreview}`
              : "";
          const currentSuffix =
            session.sessionId === currentSessionId ? " (current)" : "";
          return {
            label: `${session.updatedAt} | ${session.model}${preview}${currentSuffix}`,
            value: session.path,
          };
        }),
      );
    },
    async selectSecurityBypass(toolName, errorMessage) {
      const selected = await select(
        `[security] ${toolName} was blocked.\n${errorMessage}\nRetry with SecurityBypass?`,
        [
          {
            label: "Bypass and retry",
            value: "bypass",
          },
          {
            label: "Do not bypass",
            value: "no-bypass",
          },
        ],
      );

      return selected === "bypass";
    },
    updateTokenStatus(snapshot) {
      tokenStatus = snapshot;
    },
    resetSessionUiState() {
      history = new HistoryManager();
      tokenStatus = null;
      stickyBar.clear();
    },
    writeStatus(message) {
      for (const line of message.split("\n")) {
        printStatus(line);
      }
    },
    writeToolCall(name, args) {
      printToolCall(name, args);
    },
    writeOutput(message) {
      writeRaw(message, process.stdout);
    },
    writeError(message) {
      for (const line of message.split("\n")) {
        printError(line);
      }
    },
  };
}
