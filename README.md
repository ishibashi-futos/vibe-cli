# vibe-cli

To install dependencies:

```bash
bun install
```

To run:

```bash
OPENAI_BASE_URL=http://172.20.10.3:1234/v1 \
OPENAI_API_KEY=lmstudio \
OPENAI_MODEL=qwen2.5-coder-7b-instruct-mlx \
bun run src/cli/index.ts
```

This project was created using `bun init` in bun v1.3.10. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
