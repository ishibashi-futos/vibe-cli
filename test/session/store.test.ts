import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChatMessage,
  OpenAIUsage,
  SessionEvent,
} from "../../src/domain/types";
import {
  appendSessionEvent,
  createSessionFilePath,
  initializeSessionLog,
  listSessionSummaries,
  loadSession,
  resolveSessionSelector,
} from "../../src/session/store";

function usage(total: number): OpenAIUsage {
  return {
    prompt_tokens: Math.floor(total / 2),
    completion_tokens: total - Math.floor(total / 2),
    total_tokens: total,
  };
}

describe("session store", () => {
  test("creates expected session file path", () => {
    const path = createSessionFilePath({
      workspaceRoot: "/tmp/workspace",
      sessionId: "abc123",
      now: new Date(2026, 2, 11, 1, 2, 3),
    });

    expect(path).toContain(
      "/tmp/workspace/.agents/sessions/20260311010203-abc123.jsonl",
    );
  });

  test("appends state and messages and reloads them", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "session-store-"));
    const sessionPath = createSessionFilePath({
      workspaceRoot,
      sessionId: "session-1",
      now: new Date("2026-03-11T00:00:00Z"),
    });

    initializeSessionLog({
      path: sessionPath,
      sessionId: "session-1",
      workspaceRoot,
      configFilePath: join(workspaceRoot, ".agents", "vibe-config.json"),
      createdAt: "2026-03-10T15:00:00.000Z",
    });
    appendSessionEvent(sessionPath, {
      type: "message",
      timestamp: "2026-03-10T15:00:01.000Z",
      message: { role: "system", content: "sys" },
    });
    appendSessionEvent(sessionPath, {
      type: "session_state",
      timestamp: "2026-03-10T15:00:02.000Z",
      state: {
        currentModel: "test-model",
        workflowGateEnabled: false,
        lastUsage: usage(10),
        cumulativeUsage: usage(20),
      },
    });
    appendSessionEvent(sessionPath, {
      type: "message",
      timestamp: "2026-03-10T15:00:03.000Z",
      message: { role: "user", content: "hello" },
    });
    appendSessionEvent(sessionPath, {
      type: "hook_event",
      timestamp: "2026-03-10T15:00:04.000Z",
      phase: "done",
      hookName: "workflow-phase-gate",
      resultKind: "block_finalize",
      summary: "blocked",
      artifacts: { summary: "blocked" },
    });

    const loaded = loadSession(sessionPath);
    expect(loaded.sessionId).toBe("session-1");
    expect(loaded.state.currentModel).toBe("test-model");
    expect(loaded.state.workflowGateEnabled).toBe(false);
    expect(loaded.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
    expect(loaded.hookEvents).toHaveLength(1);
  });

  test("resolves selector by path basename and uuid suffix", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "session-selector-"));
    const sessionId = "11111111-2222-3333-4444-abcdefabcdef";
    const sessionPath = createSessionFilePath({
      workspaceRoot,
      sessionId,
      now: new Date("2026-03-11T00:00:00Z"),
    });
    initializeSessionLog({
      path: sessionPath,
      sessionId,
      workspaceRoot,
      configFilePath: null,
      createdAt: "2026-03-11T00:00:00.000Z",
    });

    expect(
      resolveSessionSelector({ workspaceRoot, selector: sessionPath }),
    ).toBe(sessionPath);
    expect(
      resolveSessionSelector({
        workspaceRoot,
        selector: sessionPath.split("/").at(-1) ?? "",
      }),
    ).toBe(sessionPath);
    expect(
      resolveSessionSelector({
        workspaceRoot,
        selector: "abcdefabcdef",
      }),
    ).toBe(sessionPath);
  });

  test("ignores broken trailing line", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "session-broken-"));
    const sessionPath = createSessionFilePath({
      workspaceRoot,
      sessionId: "session-2",
      now: new Date("2026-03-11T00:00:00Z"),
    });
    initializeSessionLog({
      path: sessionPath,
      sessionId: "session-2",
      workspaceRoot,
      configFilePath: null,
      createdAt: "2026-03-11T00:00:00.000Z",
    });
    appendSessionEvent(sessionPath, {
      type: "message",
      timestamp: "2026-03-11T00:00:01.000Z",
      message: { role: "system", content: "sys" },
    });
    writeFileSync(
      sessionPath,
      `${readFileSync(sessionPath, "utf8")}{"type":"message"`,
      "utf8",
    );

    const loaded = loadSession(sessionPath);
    expect(loaded.messages).toEqual([{ role: "system", content: "sys" }]);
  });

  test("trims incomplete assistant tool-call tail", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "session-tail-"));
    const sessionPath = createSessionFilePath({
      workspaceRoot,
      sessionId: "session-3",
      now: new Date("2026-03-11T00:00:00Z"),
    });
    initializeSessionLog({
      path: sessionPath,
      sessionId: "session-3",
      workspaceRoot,
      configFilePath: null,
      createdAt: "2026-03-11T00:00:00.000Z",
    });
    const events: SessionEvent[] = [
      {
        type: "message",
        timestamp: "2026-03-11T00:00:01.000Z",
        message: { role: "system", content: "sys" },
      },
      {
        type: "message",
        timestamp: "2026-03-11T00:00:02.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        timestamp: "2026-03-11T00:00:03.000Z",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        } as ChatMessage,
      },
    ];

    for (const event of events) {
      appendSessionEvent(sessionPath, event);
    }

    const loaded = loadSession(sessionPath);
    expect(loaded.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
  });

  test("lists recent session summaries", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "session-summary-"));
    mkdirSync(join(workspaceRoot, ".agents"), { recursive: true });

    const olderPath = createSessionFilePath({
      workspaceRoot,
      sessionId: "old",
      now: new Date("2026-03-10T00:00:00Z"),
    });
    initializeSessionLog({
      path: olderPath,
      sessionId: "old",
      workspaceRoot,
      configFilePath: null,
      createdAt: "2026-03-10T00:00:00.000Z",
    });
    appendSessionEvent(olderPath, {
      type: "session_state",
      timestamp: "2026-03-10T00:00:01.000Z",
      state: {
        currentModel: "old-model",
        workflowGateEnabled: true,
        lastUsage: null,
        cumulativeUsage: usage(0),
      },
    });
    appendSessionEvent(olderPath, {
      type: "message",
      timestamp: "2026-03-10T00:00:02.000Z",
      message: { role: "user", content: "older message" },
    });

    const newerPath = createSessionFilePath({
      workspaceRoot,
      sessionId: "new",
      now: new Date("2026-03-11T00:00:00Z"),
    });
    initializeSessionLog({
      path: newerPath,
      sessionId: "new",
      workspaceRoot,
      configFilePath: null,
      createdAt: "2026-03-11T00:00:00.000Z",
    });
    appendSessionEvent(newerPath, {
      type: "session_state",
      timestamp: "2026-03-11T00:00:01.000Z",
      state: {
        currentModel: "new-model",
        workflowGateEnabled: true,
        lastUsage: null,
        cumulativeUsage: usage(0),
      },
    });
    appendSessionEvent(newerPath, {
      type: "message",
      timestamp: "2026-03-11T00:00:02.000Z",
      message: { role: "user", content: "newer message" },
    });

    const summaries = listSessionSummaries(workspaceRoot);
    expect(summaries[0]?.sessionId).toBe("new");
    expect(summaries[0]?.model).toBe("new-model");
    expect(summaries[0]?.firstUserMessagePreview).toContain("newer");
  });
});
