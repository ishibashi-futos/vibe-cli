import { createAgentToolkit, createToolContext } from "agent-tools-ts";
import type { ToolRuntime } from "../domain/types";

export function createDefaultToolRuntime(workspaceRoot: string): ToolRuntime {
  const toolContext = createToolContext({
    workspaceRoot,
    writeScope: "workspace-write",
    policy: { tools: {}, defaultPolicy: "allow" },
  });

  const toolkit = createAgentToolkit(toolContext);

  return {
    getAllowedTools() {
      return toolkit.getAllowedTools();
    },
    getAllowedToolNames() {
      return toolkit
        .getAllowedTools()
        .map((tool) => tool.function.name)
        .sort();
    },
    async invoke(toolName, args) {
      const result = await toolkit.invoke(
        toolName as Parameters<typeof toolkit.invoke>[0],
        args,
      );

      return (result.content as Record<string, unknown>) ?? {};
    },
  };
}
