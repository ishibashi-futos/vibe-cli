import { HistoryManager, input } from "terminal-ui-kit";
import type { ConsoleIO } from "../domain/types";

export function createConsoleIO(): ConsoleIO {
  const history = new HistoryManager();

  return {
    async readUserInput(prompt) {
      const result = await input(prompt, history);
      return result.value;
    },
    writeLine(message) {
      console.log(message);
    },
    writeError(message) {
      console.error(message);
    },
  };
}
