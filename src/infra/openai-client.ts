import OpenAI from "openai";
import type { CompletionGateway } from "../domain/types";

export function createOpenAICompletionGateway(): CompletionGateway {
  const clients = new Map<string, OpenAI>();

  return {
    async request({ baseUrl, apiKey, model, messages, tools, toolChoice }) {
      const cacheKey = `${baseUrl}\n${apiKey}`;
      let client = clients.get(cacheKey);
      if (!client) {
        client = new OpenAI({
          baseURL: baseUrl,
          apiKey,
        });
        clients.set(cacheKey, client);
      }

      const response = await client.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: toolChoice,
      });

      return {
        message: response.choices[0]?.message ?? null,
        usage: response.usage ?? null,
      };
    },
  };
}
