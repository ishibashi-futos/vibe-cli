import OpenAI from "openai";
import { createAgentToolkit, createToolContext } from "agent-tools-ts";
import { HistoryManager, input } from "terminal-ui-kit";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? "http://192.168.10.13:1234/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "lmstudio",
});

const model = process.env.OPENAI_MODEL ?? "qwen2.5-coder-7b-instruct-mlx";

const toolContext = createToolContext({
  workspaceRoot: process.cwd(),
  writeScope: "workspace-write",
  policy: { tools: {}, defaultPolicy: "allow" },
});

const toolKit = createAgentToolkit(toolContext);
const tools = toolKit.getAllowedTools();
const availableToolNames = tools.map((tool) => tool.function.name).sort();
const availableToolSet = new Set(availableToolNames);

const defaultSystemPrompt = [
  "You are a coding agent running inside a CLI app.",
  `Available tools (and only these): ${availableToolNames.join(", ")}.`,
  "Never call unavailable tools. If you need file write, use apply_patch.",
  "Always prefer calling tools to perform work directly.",
  "Do NOT ask the user to run shell commands like touch/mkdir/cp/npm/bun/test/git.",
  "If the user asks to implement or modify code, do it yourself via tools.",
  "When implementing tests or fixes, proactively inspect files, edit files, and run relevant checks with tools.",
  "If you call apply_patch, provide a valid diff payload.",
  "Only ask a user question when a true product decision is required and cannot be inferred.",
  "After tool results are available, continue with additional tool calls until the task is complete, then provide a concise summary.",
].join("\n");

const systemPrompt = process.env.SYSTEM_PROMPT ?? defaultSystemPrompt;

const maxToolRounds = 12;
const maxPreviewChars = 4000;
const enforceToolCallFirstRound =
  process.env.ENFORCE_TOOL_CALL_FIRST_ROUND !== "0";

const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
  { role: "system", content: systemPrompt },
];
const history = new HistoryManager();

function toPreview(value: unknown): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  return text.length > maxPreviewChars
    ? `${text.slice(0, maxPreviewChars)}\n...<truncated>`
    : text;
}

function parseToolArgs(argumentsText: string): Record<string, unknown> {
  return JSON.parse(argumentsText || "{}");
}

function pushToolResult(
  toolCallId: string,
  content: Record<string, unknown>,
): void {
  messages.push({
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(content),
  });
}

console.log(`Chat loop started. model=${model}`);
console.log("Type /exit to quit.");
console.log("Submit with Cmd+Enter (macOS) or Ctrl+Enter (Windows/Linux).");

while (true) {
  const userInput = (await input("> ", history)).trim();

  if (!userInput) {
    continue;
  }

  if (userInput === "/exit" || userInput === "/quit") {
    break;
  }

  messages.push({ role: "user", content: userInput });

  try {
    let printedFinal = false;

    for (let round = 0; round < maxToolRounds; round++) {
      console.log(`[status] thinking... (round ${round + 1}/${maxToolRounds})`);
      let response = await client.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: "auto",
      });

      let assistantMessage = response.choices[0]?.message;
      if (!assistantMessage) {
        console.log("[assistant] (empty response)");
        printedFinal = true;
        break;
      }

      let toolCalls = assistantMessage.tool_calls ?? [];
      if (
        enforceToolCallFirstRound &&
        round === 0 &&
        toolCalls.length === 0
      ) {
        console.log(
          "[status] no tool call in round 1, retrying with tool_choice=required",
        );
        response = await client.chat.completions.create({
          model,
          messages,
          tools,
          tool_choice: "required",
        });
        assistantMessage = response.choices[0]?.message;
        if (!assistantMessage) {
          console.log("[assistant] (empty response)");
          printedFinal = true;
          break;
        }
        toolCalls = assistantMessage.tool_calls ?? [];
      }

      if (toolCalls.length === 0) {
        const assistantText = assistantMessage.content ?? "";
        messages.push({ role: "assistant", content: assistantText });

        if (!assistantText) {
          console.log("[assistant] (empty response)");
        } else {
          console.log(`\n${assistantText}\n`);
        }

        printedFinal = true;
        break;
      }

      messages.push({
        role: "assistant",
        content: assistantMessage.content ?? "",
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        if (toolCall.type !== "function") {
          continue;
        }

        const toolName = toolCall.function.name;

        console.log(`\n[tool] calling ${toolName}`);
        console.log(`[tool] args: ${toPreview(toolCall.function.arguments)}`);

        let args: Record<string, unknown> = {};

        try {
          args = parseToolArgs(toolCall.function.arguments);
        } catch (error) {
          const parseError = error instanceof Error ? error.message : String(error);

          pushToolResult(toolCall.id, {
            status: "failure",
            reason: "invalid_arguments_json",
            message: parseError,
          });
          console.log(`[tool] error: invalid arguments JSON: ${parseError}`);
          continue;
        }

        if (!availableToolSet.has(toolName)) {
          const message = `Tool '${toolName}' is not available. Available tools: ${availableToolNames.join(", ")}`;
          pushToolResult(toolCall.id, {
            status: "failure",
            reason: "tool_not_available",
            message,
          });
          console.log(`[tool] error: ${message}`);
          continue;
        }

        try {
          const result = await toolKit.invoke(
            toolName as Parameters<typeof toolKit.invoke>[0],
            args,
          );

          pushToolResult(
            toolCall.id,
            (result.content as Record<string, unknown>) ?? {},
          );
          console.log(`[tool] response from ${toolName}:`);
          console.log(toPreview(result.content));
        } catch (error) {
          const invokeError = error instanceof Error ? error.message : String(error);
          pushToolResult(toolCall.id, {
            status: "failure",
            reason: "tool_invoke_error",
            message: invokeError,
          });
          console.log(`[tool] error from ${toolName}: ${invokeError}`);
        }
      }
    }

    if (!printedFinal) {
      console.log(`[assistant] tool loop reached max rounds (${maxToolRounds}).`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Request failed: ${message}`);
  }
}
