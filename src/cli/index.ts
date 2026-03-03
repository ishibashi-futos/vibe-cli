import OpenAI from "openai";
const client = new OpenAI({
  "baseURL": "http://172.20.10.3:1234/v1",
  "apiKey": "lmstudio",
});

const response = await client.chat.completions.create({
  model: "qwen2.5-coder-7b-instruct-mlx",
  messages: [{
    "role": "user",
    "content": "how are you?"
  }],
});

console.log(response.choices[0]?.message);
