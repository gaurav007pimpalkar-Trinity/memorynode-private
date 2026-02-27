# MemoryNode Quickstart

**MemoryNode is a memory layer for AI applications.** AI apps need persistent, queryable memory—otherwise every conversation starts from zero. MemoryNode gives you store-and-retrieve memory and semantic search through a single API; vectors, embeddings, and search infrastructure are handled for you.

**Built for** developers shipping AI apps that need persistent, queryable memory (chatbots, copilots, agents).

---

## Features

- **Store memories** — Send facts, preferences, or conversation snippets scoped by user and optional namespace.
- **Semantic search** — Query in natural language; get the most relevant memories back.
- **Prompt-ready context** — One API call returns formatted context and citations for your AI prompt.
- **API-first** — Use the REST API or the official TypeScript/JavaScript SDK.

---

## Get an API key

1. Sign up at **[app.memorynode.ai](https://app.memorynode.ai)**.
2. Create a workspace and an API key in the dashboard.
3. Use the key as the `API_KEY` environment variable when you run the quickstart.

---

## Why MemoryNode?

- **No infrastructure** — No vector DB, embeddings pipeline, or search cluster to run or scale.
- **Simple DX** — One SDK, clear API, config via env vars. Ship in minutes.
- **Built for AI** — Per-user memory, semantic search, and prompt-ready context for agents and apps.
- **Production-ready** — Hosted API, built for real workloads.

---

## Quickstart (copy-paste runnable)

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/YOUR_ORG/memorynode-quickstart.git
cd memorynode-quickstart
npm install
export API_KEY=your_api_key_here
export BASE_URL=https://api.memorynode.ai
npm start
```

Replace `YOUR_ORG` with your GitHub org or username once the repo is created. The script adds a sample memory, searches for it, and prints the results. No code to write — the repo includes `index.mjs`.

**Without cloning:** run `npm install @memorynodeai/sdk`, paste the code below into `index.mjs`, set `API_KEY` (and optionally `BASE_URL`), then `node index.mjs`.

---

## What’s inside (`index.mjs`)

```javascript
import { MemoryNodeClient } from "@memorynodeai/sdk";

const apiKey = process.env.API_KEY?.trim();
if (!apiKey) throw new Error("Missing API_KEY. Set it with: export API_KEY=your_key");

const client = new MemoryNodeClient({
  apiKey,
  baseUrl: process.env.BASE_URL?.trim() || "https://api.memorynode.ai",
});

async function main() {
  await client.addMemory({
    userId: "quickstart-user",
    namespace: "default",
    text: "MemoryNode quickstart ran at " + new Date().toISOString(),
    metadata: { source: "quickstart" },
  });
  const results = await client.search({
    userId: "quickstart-user",
    namespace: "default",
    query: "quickstart",
    topK: 5,
  });
  console.log("Search results:", JSON.stringify(results, null, 2));
}
main().catch((err) => { console.error(err); process.exit(1); });
```

---

## Documentation

Full API reference, guides, and best practices: **[docs.memorynode.ai](https://docs.memorynode.ai)**.

---

## License

MIT.
