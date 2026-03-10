import {
  SecurityBypass,
  createAgentToolkit,
  createToolContext,
  type ToolPolicy,
  type FileAccessMode,
} from "agent-tools-ts";
import { basename } from "node:path";
import type { ToolRuntime } from "../domain/types";
import { loadVibeConfigFile } from "../config/vibe-config";

const DEFAULT_WRITE_SCOPE: FileAccessMode = "workspace-write";
const INTERNAL_TASK_TOOL_NAMES = [
  "task_create_many",
  "task_list",
  "task_update",
  "task_update_status",
  "task_validate_completion",
] as const;
const DEFAULT_POLICY: ToolPolicy = {
  tools: {},
  defaultPolicy: "allow",
};

interface LoadedToolRuntimeConfig {
  writeScope: FileAccessMode;
  policy: ToolPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadToolRuntimeConfig(
  workspaceRoot: string,
  configFilePath: string | null = null,
): LoadedToolRuntimeConfig {
  const loaded = loadVibeConfigFile(workspaceRoot, configFilePath);
  if (!loaded.parsed) {
    return {
      writeScope: DEFAULT_WRITE_SCOPE,
      policy: DEFAULT_POLICY,
    };
  }

  const toolRuntime = loaded.parsed.tool_runtime;
  if (!isRecord(toolRuntime)) {
    return {
      writeScope: DEFAULT_WRITE_SCOPE,
      policy: DEFAULT_POLICY,
    };
  }

  const writeScopeRaw = toolRuntime.write_scope;
  const writeScope: FileAccessMode =
    writeScopeRaw === "read-only" ||
    writeScopeRaw === "workspace-write" ||
    writeScopeRaw === "unrestricted"
      ? writeScopeRaw
      : DEFAULT_WRITE_SCOPE;

  const policyRaw = toolRuntime.policy;
  if (!isRecord(policyRaw)) {
    return {
      writeScope,
      policy: DEFAULT_POLICY,
    };
  }

  const defaultPolicyRaw = policyRaw.default_policy;
  const defaultPolicy: "allow" | "deny" =
    defaultPolicyRaw === "allow" || defaultPolicyRaw === "deny"
      ? defaultPolicyRaw
      : DEFAULT_POLICY.defaultPolicy;

  const toolsRaw = policyRaw.tools;
  const tools: ToolPolicy["tools"] = {};
  if (isRecord(toolsRaw)) {
    for (const [name, value] of Object.entries(toolsRaw)) {
      if (value === "allow" || value === "deny") {
        tools[name as keyof ToolPolicy["tools"]] = value;
      }
    }
  }

  return {
    writeScope,
    policy: {
      tools,
      defaultPolicy,
    },
  };
}

export function createDefaultToolRuntime(
  workspaceRoot: string,
  options: {
    configFilePath?: string | null;
  } = {},
): ToolRuntime {
  const loaded = loadToolRuntimeConfig(
    workspaceRoot,
    options.configFilePath ?? null,
  );
  const toolContext = createToolContext({
    workspaceRoot,
    writeScope: loaded.writeScope,
    policy: loaded.policy,
  });

  const toolkit = createAgentToolkit(toolContext);
  const internalTaskToolkit = createAgentToolkit(
    createToolContext({
      workspaceRoot,
      writeScope: loaded.writeScope,
      policy: {
        defaultPolicy: "deny",
        tools: Object.fromEntries(
          INTERNAL_TASK_TOOL_NAMES.map((toolName) => [toolName, "allow"]),
        ) as ToolPolicy["tools"],
      },
    }),
  );

  const getEffectiveAllowedTools = () => {
    const combined = new Map(
      toolkit
        .getAllowedTools()
        .map((tool) => [tool.function.name, tool] as const),
    );
    for (const tool of internalTaskToolkit.getAllowedTools()) {
      combined.set(tool.function.name, tool);
    }
    return Array.from(combined.values()).sort((left, right) =>
      left.function.name.localeCompare(right.function.name),
    );
  };

  return {
    getAllowedTools() {
      return getEffectiveAllowedTools();
    },
    getAllowedToolNames() {
      return getEffectiveAllowedTools().map((tool) => tool.function.name);
    },
    getExecutionEnvironment() {
      const shell =
        process.env.SHELL ??
        process.env.ComSpec ??
        (toolContext.env.platform === "win32" ? "pwsh.exe" : "unknown");
      return {
        platform: toolContext.env.platform,
        osRelease: toolContext.env.osRelease,
        shell: basename(shell),
      };
    },
    getSecuritySummary() {
      const explicitDenyTools = Object.entries(loaded.policy.tools)
        .filter(([, access]) => access === "deny")
        .map(([name]) => name)
        .sort();
      return {
        writeScope: loaded.writeScope,
        defaultPolicy: loaded.policy.defaultPolicy,
        explicitDenyTools,
      };
    },
    async invoke(toolName, args, options) {
      const invokeTool = () =>
        toolkit.invoke(toolName as Parameters<typeof toolkit.invoke>[0], args);
      const result = options?.securityBypass
        ? await SecurityBypass.run(invokeTool)
        : await invokeTool();

      return (result.content as Record<string, unknown>) ?? {};
    },
  };
}
