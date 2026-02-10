# LangChain Wrapper Example

This example provides a tiny adapter that calls MemoryNode `/v1/context` and injects it into a prompt.

## Files

- `memorynode-context-adapter.mjs`: reusable adapter class
- `demo.mjs`: runnable usage example

## Run

```bash
BASE_URL=https://<api-host> API_KEY=mn_live_... USER_ID=demo-user NAMESPACE=demo node examples/langchain-wrapper/demo.mjs
```

PowerShell:

```powershell
$env:BASE_URL="https://<api-host>"
$env:API_KEY="mn_live_..."
$env:USER_ID="demo-user"
$env:NAMESPACE="demo"
node examples/langchain-wrapper/demo.mjs
```

## Optional LangChain integration snippet

```js
import { ChatOpenAI } from "@langchain/openai";
import { MemoryNodeContextAdapter } from "./memorynode-context-adapter.mjs";

const llm = new ChatOpenAI({ model: "gpt-4o-mini" });
const memory = new MemoryNodeContextAdapter({
  baseUrl: process.env.BASE_URL,
  apiKey: process.env.API_KEY,
  namespace: "chat-prod",
});

const { prompt } = await memory.buildAugmentedPrompt({
  userId: "user-123",
  question: "What should I prioritize this week?",
});

const answer = await llm.invoke(prompt);
console.log(answer.content);
```
