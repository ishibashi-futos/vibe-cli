# CLI Coding Agent Architecture
(Chat Completions + Function Calling Only)

## Constraints

- Chat Completions API only
- No native tool calling
- Function calling is available
- Main libraries: `terminal-ui-kit`, `agent-tools-ts`
Native tool calling is unavailable, so the app must implement a manual function-call loop.

## 1. Layered Architecture

### 1) UI Layer (`terminal-ui-kit`)

Responsibility: interactive CLI only.
- Accept user input
- Stream assistant output
- Render plans/diffs/logs
- Ask confirmation before sensitive actions
The UI never executes workspace logic; it delegates to Agent Core.

### 2) Agent Core (Orchestrator)

Responsibility: state + execution control.
State:
- `messages[]` (full conversation history)
- `workingMemory` (goals, active files, branch, etc.)
- Optional workspace summary
Chat Completions is stateless, so context is reconstructed on every request.
Execution loop:
```text
User input
 -> Chat Completion (functions enabled)
 -> function_call?
    -> yes: validate -> execute -> append result -> call model again
    -> no: final response
```

Execution authority always remains in the application.

### 3) Tool Runtime (`agent-tools-ts`)

Responsibility: controlled workspace interaction.
Bind runtime context:
- `workspaceRoot`
- `writeScope`
- `policy`
Typical functions:
- `read_file`, `list_dir`, `search`
- `apply_patch`, `run_shell`
- `git_*`, `run_tests`
For every model-proposed call:
1. Validate against policy
2. Optionally request user confirmation
3. Execute in sandbox
4. Log result and return it to conversation

## 2. Function Calling Strategy

Define explicit JSON schemas for every allowed function.
Rules:
- Any file/system access must go through functions
- Never assume unseen files
- No direct mutation outside function invocation
Execution results are added as `function` role messages, then re-evaluated by the model.

## 3. Permission Model

Use `agent-tools-ts` controls:
- `writeScope`: `"read-only" | "workspace-write" | "unrestricted"`
- Per-tool allow/deny policy
Recommended defaults:
- Start at `read-only`
- Deny by default
- Require confirmation for writes, shell commands, and git operations
Keep these concerns separate:
- Model intent
- Execution permission
- User consent

## 4. Message Structure

Each Chat Completion request should include:
- `system` (rules, safety constraints, execution protocol)
- Optional workspace summary
- Current `user` input
- Prior `assistant` and `function` messages
Each function result should return structured output:
- function name
- arguments
- stdout / stderr
- exit code
This enables traceability and deterministic debugging.

## Design Principle

Recreate tool-calling behavior via structured function calls, controlled loop execution, sandboxing (`agent-tools-ts`), and explicit confirmation (`terminal-ui-kit`).
The model proposes actions; the application decides and executes.
