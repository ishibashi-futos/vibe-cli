import {
  createAgentToolkit,
  createToolContext,
  type FileAccessMode,
  type ToolPolicy,
} from "agent-tools-ts";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ToolRuntime } from "../domain/types";

const DEFAULT_WRITE_SCOPE: FileAccessMode = "workspace-write";
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

function loadToolRuntimeConfig(workspaceRoot: string): LoadedToolRuntimeConfig {
  const filePath = join(workspaceRoot, ".agents", "vibe-config.json");
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {
        writeScope: DEFAULT_WRITE_SCOPE,
        policy: DEFAULT_POLICY,
      };
    }

    const toolRuntime = parsed.tool_runtime;
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
  } catch {
    return {
      writeScope: DEFAULT_WRITE_SCOPE,
      policy: DEFAULT_POLICY,
    };
  }
}

export function createDefaultToolRuntime(workspaceRoot: string): ToolRuntime {
  const loaded = loadToolRuntimeConfig(workspaceRoot);
  const toolContext = createToolContext({
    workspaceRoot,
    writeScope: loaded.writeScope,
    policy: loaded.policy,
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
    async invoke(toolName, args) {
      const result = await toolkit.invoke(
        toolName as Parameters<typeof toolkit.invoke>[0],
        args,
      );

      return (result.content as Record<string, unknown>) ?? {};
    },
  };
}
