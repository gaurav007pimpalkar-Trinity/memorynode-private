# MemoryNode

**Reliable per-user memory for customer-facing AI** — support bots, SMB chat, and SaaS copilots need persistent, queryable memory. MemoryNode provides store-and-retrieve memory and semantic search as a single API; embeddings and search infrastructure are managed for you.

**Canonical story:** [docs/external/POSITIONING.md](../docs/external/POSITIONING.md) in the main repo.

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
2. Create a project and an API key.
3. Use it as the `API_KEY` environment variable below.

---

## Quickstart (standalone package)

**Prerequisites:** Node.js 20+

From **this folder** (`public-onboarding`):

```bash
npm install
export API_KEY=your_api_key_here
npm start
```

**From the MemoryNode monorepo root** (uses `pnpm` workspaces):

```bash
pnpm install
cd public-onboarding
export API_KEY=your_api_key_here
pnpm start
```

**What happens:** The script adds a sample memory, runs a semantic search, and prints the results. You should see `Added memory: <id>` and a `Search results` JSON block. No code to write—`index.mjs` is ready to run.

**Without cloning the monorepo:** `npm install @memorynodeai/sdk`, then use the same code as in `index.mjs` (see repo); set `API_KEY` and run `node index.mjs`.

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
  // SDK field `namespace` maps to API `scope`.
  namespace: "default",
  text: "MemoryNode quickstart ran at " + new Date().toISOString(),
  metadata: { source: "quickstart" },
});

// Semantic search
const results = await client.search({
  userId: "quickstart-user",
  // SDK field `namespace` maps to API `scope`.
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
- **Limits and scaling:** See [docs/external/README.md](../docs/external/README.md) for usage caps, rate limits, and recipes.

---

## Documentation

- **Recipes:** [support](../docs/external/RECIPE_SUPPORT_AGENT.md) · [SaaS copilot](../docs/external/RECIPE_SAAS_COPILOT.md) · [SMB](../docs/external/RECIPE_SMB_CHATBOT.md)
- **Quickstart (curl):** [docs/start-here/README.md](../docs/start-here/README.md)
- **Trust:** [docs/external/TRUST.md](../docs/external/TRUST.md)

**Repository:** [github.com/gaurav007pimpalkar-Trinity/memorynode](https://github.com/gaurav007pimpalkar-Trinity/memorynode)

---

## License

MIT
