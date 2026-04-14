# @memorynodeai/sdk

Official JavaScript/TypeScript client for **MemoryNode** — a memory layer for AI applications. Store and retrieve user memories (facts, preferences, events) with semantic search and RAG-ready context.

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
  namespace: "default",
  text: "Prefers dark mode and keyboard shortcuts",
  metadata: { source: "settings" },
});

// Search
const results = await client.search({
  userId: "user-1",
  namespace: "default",
  query: "user preferences",
  topK: 5,
});

// Optional: import an artifact (paid plans only)
await client.importMemories("<artifact_base64>", "upsert");
```

Get an API key at [console.memorynode.ai](https://console.memorynode.ai).

## Links

- **GitHub:** [github.com/gaurav007pimpalkar-Trinity/memorynode](https://github.com/gaurav007pimpalkar-Trinity/memorynode)
- **Docs:** [docs.memorynode.ai](https://docs.memorynode.ai)

## License

MIT
