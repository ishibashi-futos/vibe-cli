export type ParsedCliArgs =
  | {
      ok: true;
      mode: "chat";
      configFilePath: string | null;
    }
  | {
      ok: true;
      mode: "exec";
      configFilePath: string | null;
      instructionArgs: string[];
    }
  | {
      ok: false;
      error: string;
    };

function parseConfigOption(
  args: string[],
  index: number,
): { value: string; nextIndex: number } | null {
  const token = args[index];
  if (!token) {
    return null;
  }
  if (token === "-c" || token === "--config-file") {
    const next = args[index + 1];
    if (!next || next.startsWith("-")) {
      return null;
    }
    return {
      value: next,
      nextIndex: index + 1,
    };
  }

  if (token.startsWith("--config-file=")) {
    const value = token.slice("--config-file=".length);
    return value.length > 0
      ? {
          value,
          nextIndex: index,
        }
      : null;
  }

  if (token.startsWith("-c=")) {
    const value = token.slice(3);
    return value.length > 0
      ? {
          value,
          nextIndex: index,
        }
      : null;
  }

  return {
    value: "",
    nextIndex: index,
  };
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const positional: string[] = [];
  let configFilePath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    const parsedConfig = parseConfigOption(argv, index);
    if (parsedConfig && parsedConfig.value.length > 0) {
      configFilePath = parsedConfig.value;
      index = parsedConfig.nextIndex;
      continue;
    }

    if (
      token === "-c" ||
      token === "--config-file" ||
      token === "-c=" ||
      token === "--config-file="
    ) {
      return {
        ok: false,
        error: "missing value for -c/--config-file",
      };
    }

    positional.push(token);
  }

  if (positional.length === 0) {
    return {
      ok: true,
      mode: "chat",
      configFilePath,
    };
  }

  const subcommand = positional[0];
  if (subcommand !== "exec") {
    return {
      ok: false,
      error: `unknown subcommand: ${subcommand}`,
    };
  }

  return {
    ok: true,
    mode: "exec",
    configFilePath,
    instructionArgs: positional.slice(1),
  };
}
