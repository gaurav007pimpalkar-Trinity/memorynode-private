# @memorynodeai/sdk

Official JavaScript/TypeScript client for **MemoryNode** — **MemoryNode lets you store, retrieve, and explain why AI remembered something.** Use it from your **backend** (never ship the API key to browsers in production).

Product story and ICP: [POSITIONING.md](https://github.com/gaurav007pimpalkar-Trinity/memorynode/blob/main/docs/external/POSITIONING.md) (monorepo).

## Install

```bash
npm install @memorynodeai/sdk
```

## Quick example

```ts
import { MemoryNodeClient } from "@memorynodeai/sdk";

const client = new MemoryNodeClient({
  apiKey: process.env.API_KEY,
  baseUrl: "https://api.memorynode.ai",
});

// Add a memory
await client.addMemory({
  userId: "user-1",
  // SDK field `namespace` maps to API `scope`.
  namespace: "default",
  text: "Prefers dark mode and keyboard shortcuts",
  metadata: { source: "settings" },
});

// Or use unified ingest / transcript helpers
await client.ingest({ kind: "memory", body: { userId: "user-1", namespace: "default", text: "Note" } });
await client.addConversationMemory({
  userId: "user-1",
  namespace: "default",
  messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }],
});

// Search
const results = await client.search({
  userId: "user-1",
  // SDK field `namespace` maps to API `scope`.
  namespace: "default",
  query: "user preferences",
  topK: 5,
});

// Build prompt-ready context
const context = await client.context({
  userId: "user-1",
  // SDK field `namespace` maps to API `scope`.
  namespace: "default",
  query: "What do we know about this user's preferences?",
  topK: 5,
});

// Explain ranking decisions (core debugging tool)
const explain = await client.contextExplain({
  userId: "user-1",
  // SDK field `namespace` maps to API `scope`.
  namespace: "default",
  query: "What do we know about this user's preferences?",
  topK: 5,
});

console.log(results.results[0]);
console.log(context.context_text);
console.log(explain.results[0]?.scores, explain.results[0]?.ordering_explanation);

// Optional: import an artifact (paid plans only)
await client.importMemories("<artifact_base64>", "upsert");
```

Get an API key at [console.memorynode.ai](https://console.memorynode.ai). **Quickstart:** [docs/start-here/README.md](../../docs/start-here/README.md).

## Links

- **GitHub:** [github.com/gaurav007pimpalkar-Trinity/memorynode](https://github.com/gaurav007pimpalkar-Trinity/memorynode)
- **Docs:** [docs.memorynode.ai](https://docs.memorynode.ai)

## License

MIT
