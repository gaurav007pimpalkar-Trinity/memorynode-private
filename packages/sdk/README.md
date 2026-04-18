# @memorynodeai/sdk

Official JavaScript/TypeScript client for **MemoryNode** — **reliable per-user memory for customer-facing AI**. Store and retrieve memories (facts, preferences, events) with hybrid search and prompt-ready context from your **backend** (never ship the API key to browsers in production).

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

Get an API key at [console.memorynode.ai](https://console.memorynode.ai). **Quickstart:** [docs/start-here/README.md](../../docs/start-here/README.md).

## Links

- **GitHub:** [github.com/gaurav007pimpalkar-Trinity/memorynode](https://github.com/gaurav007pimpalkar-Trinity/memorynode)
- **Docs:** [docs.memorynode.ai](https://docs.memorynode.ai)

## License

MIT
