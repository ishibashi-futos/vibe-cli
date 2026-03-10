#!/bin/zsh

bun remove terminal-ui-kit
bun remove agent-tools-ts

TERMINAL_UI_KIT_TAG="v0.3.0"
bun add "github:ishibashi-futos/terminal-ui-kit#$TERMINAL_UI_KIT_TAG"
AGENT_TOOLS_TS_TAG="v0.6.0"
bun add "github:ishibashi-futos/agent-tools-ts#$AGENT_TOOLS_TS_TAG"

rm -rf node_modules/
bun install
