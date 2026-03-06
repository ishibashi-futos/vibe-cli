import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../../src/cli/argv";

describe("parseCliArgs", () => {
  test("defaults to chat mode", () => {
    const parsed = parseCliArgs([]);

    expect(parsed).toEqual({
      ok: true,
      mode: "chat",
      configFilePath: null,
    });
  });

  test("parses exec mode with config file", () => {
    const parsed = parseCliArgs([
      "-c",
      ".agents/review/vibe-config.json",
      "exec",
      "run",
      "tests",
    ]);

    expect(parsed).toEqual({
      ok: true,
      mode: "exec",
      configFilePath: ".agents/review/vibe-config.json",
      instructionArgs: ["run", "tests"],
    });
  });

  test("parses --config-file=value form", () => {
    const parsed = parseCliArgs([
      "--config-file=.agents/review/vibe-config.json",
      "exec",
      "review",
    ]);

    expect(parsed).toEqual({
      ok: true,
      mode: "exec",
      configFilePath: ".agents/review/vibe-config.json",
      instructionArgs: ["review"],
    });
  });

  test("fails when config file option has no value", () => {
    const parsed = parseCliArgs(["exec", "-c"]);
    expect(parsed).toEqual({
      ok: false,
      error: "missing value for -c/--config-file",
    });
  });

  test("fails on unknown subcommand", () => {
    const parsed = parseCliArgs(["foo"]);
    expect(parsed).toEqual({
      ok: false,
      error: "unknown subcommand: foo",
    });
  });
});
