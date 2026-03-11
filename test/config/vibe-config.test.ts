import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDefaultVibeConfigContent,
  initializeVibeConfig,
} from "../../src/config/vibe-config";

describe("vibe-config", () => {
  test("builds default config content with placeholders", () => {
    expect(buildDefaultVibeConfigContent()).toBe(
      `${JSON.stringify(
        {
          default_model: "model_name",
          max_tool_rounds: 12,
          max_preview_chars: 4000,
          mention_max_lines: 100,
          chat_workflow_gate_enabled: true,
          enforce_tool_call_first_round: true,
          hooks: {},
          tool_runtime: {
            write_scope: "workspace-write",
            policy: {
              default_policy: "deny",
              tools: {
                read_file: "allow",
                tree: "allow",
                regexp_search: "allow",
                ast_grep_search: "allow",
              },
            },
          },
          models: {
            model_name: {
              context_length: 32768,
              base_url: "http://localhost:1234/v1",
              api_key: "lmstudio",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  });

  test("initializes config file at default path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-init-test-"));
    try {
      const path = initializeVibeConfig(cwd);

      expect(path).toBe(join(cwd, ".agents", "vibe-config.json"));
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(buildDefaultVibeConfigContent());
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("throws when config file already exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-init-test-"));
    const path = join(cwd, ".agents", "vibe-config.json");
    try {
      mkdirSync(join(cwd, ".agents"), { recursive: true });
      writeFileSync(path, "{}\n", "utf8");
      expect(() => initializeVibeConfig(cwd)).toThrow(
        `config file already exists: ${path}`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
