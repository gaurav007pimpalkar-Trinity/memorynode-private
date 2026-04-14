# MemoryNode

**MemoryNode is the memory layer for AI applications.** Agents and chat apps need persistent, queryable memory—without it, every session starts from zero. MemoryNode provides store-and-retrieve memory and semantic search as a single API; embeddings and search infrastructure are managed for you.

**Use it when** you're building chatbots, copilots, or agents that must remember users and context across sessions.

---

## Architecture

```text
Your app (Node, Python, etc.)
        │
        │  HTTPS + API key
        ▼
┌─────────────────────────────────────┐
│  MemoryNode API (hosted)             │
│  • Ingest: store text + metadata     │
│  • Embed: vectorize (handled for you)│
│  • Search: semantic + filters        │
└─────────────────────────────────────┘
        │
        ▼
  Memories returned as JSON (snippets, scores, metadata)
  → Drop into system prompt or context window
```

You send text and optional metadata; you get back relevant memories. No vector DB or embedding pipeline to run.

---

## Get an API key

1. Sign up at **[console.memorynode.ai](https://console.memorynode.ai)**.
2. Create a workspace and an API key.
3. Use it as the `API_KEY` environment variable below.

---

## Quickstart

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/gaurav007pimpalkar-Trinity/memorynode.git
cd memorynode
npm install
```

Set your API key and run (replace with your key):

```bash
export API_KEY=your_api_key_here
npm start
```

**What happens:** The script adds a sample memory, runs a semantic search, and prints the results. You should see `Added memory: <id>` and a `Search results` JSON block. No code to write—`index.mjs` is ready to run.

**Without cloning:** `npm install @memorynodeai/sdk`, then use the same code as in `index.mjs` (see repo); set `API_KEY` and run `node index.mjs`.

---

## What’s in `index.mjs`

```javascript
import { MemoryNodeClient } from "@memorynodeai/sdk";

const client = new MemoryNodeClient({
  apiKey: process.env.API_KEY,
  baseUrl: process.env.BASE_URL || "https://api.memorynode.ai",
});

// Store a memory
await client.addMemory({
  userId: "quickstart-user",
  namespace: "default",
  text: "MemoryNode quickstart ran at " + new Date().toISOString(),
  metadata: { source: "quickstart" },
});

// Semantic search
const results = await client.search({
  userId: "quickstart-user",
  namespace: "default",
  query: "quickstart",
  topK: 5,
});
console.log("Search results:", JSON.stringify(results, null, 2));
```

---

## Production usage

- **Base URL:** Default is `https://api.memorynode.ai`. Override with `BASE_URL` for self-hosted or staging.
- **Secrets:** Keep `API_KEY` in environment or a secret manager; never commit it.
- **Errors:** The SDK throws on non-2xx responses; handle network and rate-limit errors in your app.
- **Limits and scaling:** See [docs.memorynode.ai](https://docs.memorynode.ai) for usage caps, rate limits, and best practices.

---

## Documentation

API reference, guides, and context/export usage: **[docs.memorynode.ai](https://docs.memorynode.ai)**.

**Repository:** [github.com/gaurav007pimpalkar-Trinity/memorynode](https://github.com/gaurav007pimpalkar-Trinity/memorynode)

---

## License

MIT
