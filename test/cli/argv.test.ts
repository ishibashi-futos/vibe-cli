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

  test("parses init mode", () => {
    const parsed = parseCliArgs(["init"]);

    expect(parsed).toEqual({
      ok: true,
      mode: "init",
      configFilePath: null,
    });
  });

  test("parses resume mode", () => {
    const parsed = parseCliArgs(["resume"]);

    expect(parsed).toEqual({
      ok: true,
      mode: "resume",
      configFilePath: null,
      sessionSelector: null,
    });
  });

  test("parses resume selector with config file", () => {
    const parsed = parseCliArgs([
      "-c",
      ".agents/review/vibe-config.json",
      "resume",
      "abcd1234",
    ]);

    expect(parsed).toEqual({
      ok: true,
      mode: "resume",
      configFilePath: ".agents/review/vibe-config.json",
      sessionSelector: "abcd1234",
    });
  });

  test("fails when init receives positional arguments", () => {
    const parsed = parseCliArgs(["init", "extra"]);

    expect(parsed).toEqual({
      ok: false,
      error: "init does not accept positional arguments",
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

  test("fails when resume receives too many positional arguments", () => {
    const parsed = parseCliArgs(["resume", "a", "b"]);

    expect(parsed).toEqual({
      ok: false,
      error: "resume accepts at most one session selector",
    });
  });
});
