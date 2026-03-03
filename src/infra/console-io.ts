import { HistoryManager, input } from "terminal-ui-kit";
import type { ConsoleIO } from "../domain/types";

export function createConsoleIO(): ConsoleIO {
  const history = new HistoryManager();

  return {
    readUserInput(prompt) {
      return input(prompt, history);
    },
    writeLine(message) {
      console.log(message);
    },
    writeError(message) {
      console.error(message);
    },
  };
}
