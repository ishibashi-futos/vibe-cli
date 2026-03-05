# vibe-cli

## Setup

```bash
bun install
```

## Run

```bash
OPENAI_BASE_URL=http://172.20.10.3:1234/v1 \
OPENAI_API_KEY=lmstudio \
OPENAI_MODEL=qwen2.5-coder-7b-instruct-mlx \
bun run src/cli/index.ts
```

## Slash Commands

- `/help`: Show available commands
- `/model`: Select and switch model from configured entries
- `/status`: Show current model and token usage
- `/new`: Start a new session (full reset)
- `/exit`: Exit
- `/quit`: Exit (alias)

## Agent Config

- The app reads model definitions from `.agents/vibe-config.json`.
- JSON schema:

```json
{
  "models": {
    "model_name": {
      "context_length": 32768,
      "base_url": "http://localhost:1234/v1",
      "api_key": "lmstudio"
    }
  }
}
```
- `/model` can switch only to model names defined under `models`.
- `base_url` / `api_key` are optional per model. If omitted, global env (`OPENAI_BASE_URL` / `OPENAI_API_KEY`) is used.

## Mentions

- Use `@path/to/file` in input to preload file content into the user message.
- The app reads up to `100` lines per mentioned file via `read_file`.
- If content is longer than the configured max lines, it is truncated and marked.

## Token Status Bar

- Sticky status bar shows input length and token usage while typing.
- Usage ratio is shown only when the current model has `context_length` in `.agents/vibe-config.json`.
