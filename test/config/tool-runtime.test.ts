import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDefaultToolRuntime } from "../../src/infra/tool-runtime";

describe("tool-runtime config", () => {
  function withWorkspace(
    vibeConfig: string | null,
    files: Record<string, string>,
    run: (workspaceRoot: string) => void,
  ): void {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "vibe-tool-runtime-test-"),
    );
    try {
      if (vibeConfig !== null) {
        mkdirSync(join(workspaceRoot, ".agents"), { recursive: true });
        writeFileSync(
          join(workspaceRoot, ".agents", "vibe-config.json"),
          vibeConfig,
        );
      }
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(workspaceRoot, path)), { recursive: true });
        writeFileSync(join(workspaceRoot, path), content);
      }
      run(workspaceRoot);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  test("uses default allow policy when tool_runtime is not configured", () => {
    withWorkspace(JSON.stringify({ models: {} }), {}, (workspaceRoot) => {
      const runtime = createDefaultToolRuntime(workspaceRoot);
      const allowed = runtime.getAllowedToolNames();
      const executionEnv = runtime.getExecutionEnvironment?.();

      expect(allowed).toContain("read_file");
      expect(allowed).toContain("write_file");
      expect(allowed).toContain("exec_command");
      expect(executionEnv).toBeDefined();
      expect(executionEnv?.platform).toBe(process.platform);
      expect(executionEnv?.osRelease.length).toBeGreaterThan(0);
      expect(executionEnv?.shell.length).toBeGreaterThan(0);
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
      {},
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
      {},
      (workspaceRoot) => {
        const runtime = createDefaultToolRuntime(workspaceRoot);
        const allowed = runtime.getAllowedToolNames();

        expect(allowed).toContain("read_file");
        expect(allowed).toContain("write_file");
      },
    );
  });

  test("loads tool_runtime from custom config file path", () => {
    withWorkspace(
      JSON.stringify({ models: {} }),
      {
        ".agents/review/vibe-config.json": JSON.stringify({
          models: {},
          tool_runtime: {
            write_scope: "read-only",
            policy: {
              default_policy: "deny",
              tools: {
                read_file: "allow",
              },
            },
          },
        }),
      },
      (workspaceRoot) => {
        const runtime = createDefaultToolRuntime(workspaceRoot, {
          configFilePath: ".agents/review/vibe-config.json",
        });
        expect(runtime.getAllowedToolNames()).toEqual(["read_file"]);
      },
    );
  });

  test("can invoke denied tool with securityBypass option", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "vibe-tool-runtime-test-"));
    try {
      mkdirSync(join(workspaceRoot, ".agents"), { recursive: true });
      writeFileSync(
        join(workspaceRoot, ".agents", "vibe-config.json"),
        JSON.stringify({
          models: {},
          tool_runtime: {
            write_scope: "workspace-write",
            policy: {
              default_policy: "deny",
              tools: {
                read_file: "allow",
              },
            },
          },
        }),
      );
      writeFileSync(join(workspaceRoot, "README.md"), "hello");

      const runtime = createDefaultToolRuntime(workspaceRoot);

      await expect(
        runtime.invoke("exec_command", { command: ["pwd"], cwd: "." }),
      ).rejects.toThrow("TOOL_NOT_ALLOWED");

      await expect(
        runtime.invoke(
          "exec_command",
          { command: ["pwd"], cwd: "." },
          { securityBypass: true },
        ),
      ).resolves.toMatchObject({
        exit_code: 0,
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
