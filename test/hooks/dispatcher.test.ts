import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadAppConfig } from "../../src/config/runtime-config";
import { createWorkflowGate } from "../../src/domain/workflow-gate";
import { createHookDispatcher } from "../../src/hooks/dispatcher";

function withTestCwd(
  vibeConfig: Record<string, unknown>,
  files: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const originalCwd = process.cwd();
  const cwd = mkdtempSync(join(tmpdir(), "vibe-hook-test-"));

  mkdirSync(join(cwd, ".agents"), { recursive: true });
  writeFileSync(
    join(cwd, ".agents", "vibe-config.json"),
    `${JSON.stringify(vibeConfig, null, 2)}\n`,
    "utf8",
  );

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content, "utf8");
  }

  process.chdir(cwd);
  return run().finally(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });
}

describe("hook dispatcher", () => {
  test("runs built-in hooks before public hooks and respects phase filters", async () => {
    await withTestCwd(
      {
        models: {},
        hooks: {
          recorder: {
            phases: {
              done: true,
            },
          },
        },
      },
      {
        ".agents/hooks/recorder/index.ts": `
          export default {
            handle(event) {
              return {
                kind: "warn",
                artifacts: {
                  summary: event.phase ?? "none",
                },
              };
            },
          };
        `,
      },
      async () => {
        const config = loadAppConfig("sys");
        const workflowGate = createWorkflowGate({
          activated: true,
          availableToolNames: [],
        });
        const logs: string[] = [];
        const dispatcher = await createHookDispatcher({
          config,
          mode: "exec",
          workflowGate,
          getSessionId: () => null,
          getSessionPath: () => null,
          logger: {
            writeStatus(message) {
              logs.push(message);
            },
            writeError(message) {
              logs.push(message);
            },
          },
        });

        const analyze = await dispatcher.dispatch({
          name: "phase.entered",
          phase: "analyze",
          payload: {},
        });
        const done = await dispatcher.dispatch({
          name: "phase.entered",
          phase: "done",
          payload: {},
        });

        expect(analyze.results.map((item) => item.hookName)).toEqual([
          "workflow-phase-gate",
        ]);
        expect(done.results.map((item) => item.hookName)).toEqual([
          "workflow-phase-gate",
          "recorder",
        ]);
        expect(logs.some((line) => line.includes("[hook:recorder] done"))).toBe(
          true,
        );

        await dispatcher.dispose();
      },
    );
  });

  test("rejects invalid hook names", async () => {
    await withTestCwd(
      {
        models: {},
        hooks: {
          "bad/name": {},
        },
      },
      {},
      async () => {
        const config = loadAppConfig("sys");
        const workflowGate = createWorkflowGate({
          activated: true,
          availableToolNames: [],
        });

        await expect(
          createHookDispatcher({
            config,
            mode: "exec",
            workflowGate,
            getSessionId: () => null,
            getSessionPath: () => null,
            logger: {
              writeStatus() {},
              writeError() {},
            },
          }),
        ).rejects.toThrow("invalid hook name: bad/name");
      },
    );
  });
});
