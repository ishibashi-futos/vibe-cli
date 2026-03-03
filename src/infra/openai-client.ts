import OpenAI from "openai";
import type { CompletionGateway } from "../domain/types";

export function createOpenAICompletionGateway(params: {
  baseUrl: string;
  apiKey: string;
}): CompletionGateway {
  const client = new OpenAI({
    baseURL: params.baseUrl,
    apiKey: params.apiKey,
  });

  return {
    async request({ model, messages, tools, toolChoice }) {
      const response = await client.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: toolChoice,
      });

      return response.choices[0]?.message ?? null;
    },
  };
}
