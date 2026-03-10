# vibe-cli

## Setup

```bash
bun install
```

## Run

```bash
bun run src/cli/index.ts
```

## Exec Mode

- `exec` runs one autonomous task without interactive confirmation/input.
- `exec` completes only when assistant final message includes `<EXEC_DONE />`.
- At completion, CLI prints machine-readable result block:
  - `<EXEC_SUMMARY>...</EXEC_SUMMARY>`
  - `<EXEC_DONE />`
- If assistant omits `<EXEC_DONE />`, exec retries once with a strict reminder; if still missing, CLI force-emits completion block and exits.
- Pass instruction as args:

```bash
bun run src/cli/index.ts exec "Fix failing tests and run sanity"
```

- Or pass instruction from stdin:

```bash
echo "Review current changes and summarize risks" | bun run src/cli/index.ts exec
```

- `exec` exits with non-zero status when it cannot reach a final answer (for example: API failure or max rounds reached).

## Slash Commands

- `/help`: Show available commands
- `/model`: Select and switch model from configured entries
- `/status`: Show current model and token usage
- `/new`: Start a new session (full reset)
- `/exit`: Exit
- `/quit`: Exit (alias)

## Agent Config

- The app reads model definitions from `.agents/vibe-config.json` by default.
- You can override config file with `-c <path>` or `--config-file <path>` in both chat and exec modes.
- Agent instruction file defaults to `AGENTS.md` at workspace root.
- You can override instruction file path with `instruction_file` in `.agents/vibe-config.json` (for example, `CLAUDE.md`).
- JSON schema:

```json
{
  "default_model": "qwen2.5-coder-7b-instruct-mlx",
  "instruction_file": "CLAUDE.md",
  "system_prompt": "Optional full system prompt override",
  "max_tool_rounds": 12,
  "max_preview_chars": 4000,
  "mention_max_lines": 100,
  "enforce_tool_call_first_round": true,
  "tool_runtime": {
    "write_scope": "workspace-write",
    "policy": {
      "default_policy": "allow",
      "tools": {
        "exec_command": "deny"
      }
    }
  },
  "models": {
    "model_name": {
      "context_length": 32768,
      "base_url": "http://localhost:1234/v1",
      "api_key": "lmstudio"
    }
  }
}
```
- `instruction_file` can be absolute or relative.
- Relative `instruction_file` is resolved from the selected config file's directory.
- If configured `instruction_file` is missing, the app falls back to workspace root `AGENTS.md`.
- `default_model` chooses the startup model by name and must match a key under `models`.
- If `default_model` is omitted, the first entry under `models` is used.
- `system_prompt` is optional. If omitted, the built-in prompt is used and `instruction_file` content is appended.
- `max_tool_rounds`, `max_preview_chars`, `mention_max_lines`, `enforce_tool_call_first_round` are optional runtime settings.
- `tool_runtime.write_scope` is optional: `read-only | workspace-write | unrestricted` (default: `workspace-write`).
- `tool_runtime.policy.default_policy` is optional: `allow | deny` (default: `allow`).
- `tool_runtime.policy.tools` is optional per-tool override map (`allow | deny`).
- `/model` can switch only to model names defined under `models`.
- `base_url` / `api_key` are configured per model under `models`.

## Mentions

- Use `@path/to/file` in input to preload file content into the user message.
- The app reads up to `100` lines per mentioned file via `read_file`.
- If content is longer than the configured max lines, it is truncated and marked.

## Token Status Bar

- Sticky status bar shows input length and token usage while typing.
- Usage ratio is shown only when the current model has `context_length` in `.agents/vibe-config.json`.
