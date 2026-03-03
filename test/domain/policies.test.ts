import { describe, expect, test } from "bun:test";
import { buildDefaultSystemPrompt, toPreview } from "../../src/domain/policies";

describe("policies", () => {
  test("buildDefaultSystemPrompt includes available tools", () => {
    const prompt = buildDefaultSystemPrompt(["read_file", "apply_patch"]);

    expect(prompt).toContain("read_file, apply_patch");
    expect(prompt).toContain("Never call unavailable tools");
  });

  test("toPreview truncates large content", () => {
    const preview = toPreview("1234567890", 5);
    expect(preview).toContain("12345");
    expect(preview).toContain("<truncated>");
  });

  test("toPreview stringifies objects", () => {
    const preview = toPreview({ a: 1 }, 50);
    expect(preview).toContain('"a": 1');
  });
});
