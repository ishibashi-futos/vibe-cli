import {
  createStickyStatusBar,
  HistoryManager,
  input,
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

    const { model, baseUrl, lastUsage, cumulativeUsage, tokenLimit } =
      tokenStatus;
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
    writeLine(message) {
      console.log(message);
    },
    writeError(message) {
      console.error(message);
    },
  };
}
