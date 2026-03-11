import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeConfig } from "../domain/types";
import type {
  HookFactory,
  HookInitContext,
  HookMode,
  HookModule,
  RegisteredHook,
} from "./types";

function isValidHookName(hookName: string): boolean {
  return (
    hookName.length > 0 && !hookName.includes("/") && !hookName.includes("\\")
  );
}

function isHookModule(value: unknown): value is HookModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "handle" in value &&
    typeof value.handle === "function"
  );
}

export async function loadPublicHooks(params: {
  config: RuntimeConfig;
  mode: HookMode;
}): Promise<RegisteredHook[]> {
  const hooks: RegisteredHook[] = [];

  for (const hookConfig of params.config.hooks) {
    if (!isValidHookName(hookConfig.hookName)) {
      throw new Error(`invalid hook name: ${hookConfig.hookName}`);
    }

    const hookRoot = join(
      params.config.workspaceRoot,
      ".agents",
      "hooks",
      hookConfig.hookName,
    );
    const hookPath = join(hookRoot, "index.ts");
    if (!existsSync(hookPath)) {
      throw new Error(`hook module not found: ${hookPath}`);
    }

    const imported = await import(pathToFileURL(hookPath).href);
    const exported = imported.default;
    const initContext: HookInitContext = {
      hookName: hookConfig.hookName,
      workspaceRoot: params.config.workspaceRoot,
      hookRoot,
      config: hookConfig.config,
      modeCapabilities: {
        mode: params.mode,
        supportsSessionPersistence: params.mode === "chat",
      },
    };

    const moduleValue =
      typeof exported === "function"
        ? await (exported as HookFactory)(initContext)
        : exported;

    if (!isHookModule(moduleValue)) {
      throw new Error(`hook module is invalid: ${hookPath}`);
    }

    hooks.push({
      hookName: hookConfig.hookName,
      source: "public",
      onError: hookConfig.onError,
      phases: hookConfig.phases,
      module: moduleValue,
    });
  }

  return hooks;
}
