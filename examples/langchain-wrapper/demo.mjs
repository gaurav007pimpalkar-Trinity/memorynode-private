#!/usr/bin/env node
import { MemoryNodeContextAdapter } from "./memorynode-context-adapter.mjs";

const BASE_URL = (process.env.BASE_URL ?? "").trim();
const API_KEY = (process.env.API_KEY ?? "").trim();
const USER_ID = (process.env.USER_ID ?? "langchain-demo-user").trim();
const NAMESPACE = (process.env.NAMESPACE ?? "langchain-demo").trim();
const QUESTION = (process.env.QUESTION ?? "What do you remember about my preferences?").trim();

if (!BASE_URL || !API_KEY) {
  console.error("[langchain-wrapper] Missing BASE_URL or API_KEY");
  process.exit(1);
}

async function main() {
  const adapter = new MemoryNodeContextAdapter({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    namespace: NAMESPACE,
    topK: 5,
  });

  const result = await adapter.buildAugmentedPrompt({
    userId: USER_ID,
    question: QUESTION,
  });

  console.log("[langchain-wrapper] Prompt with memory context:");
  console.log(result.prompt);
  console.log("\n[langchain-wrapper] Citations:");
  console.log(JSON.stringify(result.citations, null, 2));
}

main().catch((err) => {
  console.error(`[langchain-wrapper] ${err?.message ?? String(err)}`);
  process.exit(1);
});
