import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultToolRuntime } from "../../src/infra/tool-runtime";

describe("tool-runtime config", () => {
  function withWorkspace(
    vibeConfig: string | null,
    run: (workspaceRoot: string) => void,
  ): void {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "vibe-tool-runtime-test-"));
    try {
      if (vibeConfig !== null) {
        mkdirSync(join(workspaceRoot, ".agents"), { recursive: true });
        writeFileSync(join(workspaceRoot, ".agents", "vibe-config.json"), vibeConfig);
      }
      run(workspaceRoot);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  test("uses default allow policy when tool_runtime is not configured", () => {
    withWorkspace(JSON.stringify({ models: {} }), (workspaceRoot) => {
      const runtime = createDefaultToolRuntime(workspaceRoot);
      const allowed = runtime.getAllowedToolNames();

      expect(allowed).toContain("read_file");
      expect(allowed).toContain("write_file");
      expect(allowed).toContain("exec_command");
    });
  });

  test("loads write_scope and policy from .agents/vibe-config.json", () => {
    withWorkspace(
      JSON.stringify({
        models: {},
        tool_runtime: {
          write_scope: "read-only",
          policy: {
            default_policy: "deny",
            tools: {
              read_file: "allow",
              tree: "allow",
            },
          },
        },
      }),
      (workspaceRoot) => {
        const runtime = createDefaultToolRuntime(workspaceRoot);

        expect(runtime.getAllowedToolNames()).toEqual(["read_file", "tree"]);
      },
    );
  });

  test("falls back to defaults for invalid tool_runtime fields", () => {
    withWorkspace(
      JSON.stringify({
        models: {},
        tool_runtime: {
          write_scope: "invalid-scope",
          policy: {
            default_policy: "invalid",
            tools: {
              read_file: "maybe",
            },
          },
        },
      }),
      (workspaceRoot) => {
        const runtime = createDefaultToolRuntime(workspaceRoot);
        const allowed = runtime.getAllowedToolNames();

        expect(allowed).toContain("read_file");
        expect(allowed).toContain("write_file");
      },
    );
  });
});
