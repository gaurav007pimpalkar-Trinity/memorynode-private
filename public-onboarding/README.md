## ℹ️ Supporting documentation

This folder is a **minimal runnable quickstart** for the hosted API. For exact HTTP behavior, see the monorepo:

- [../docs/external/API_USAGE.md](../docs/external/API_USAGE.md)
- [../docs/external/openapi.yaml](../docs/external/openapi.yaml) (regenerate from the monorepo with `pnpm openapi:gen`)

**Full product README (marketing + API overview, MCP, examples):** [../README.md](../README.md)

---

# MemoryNode — public quickstart

**Reliable per-user memory for customer-facing AI** — this package runs a short script that adds a memory, searches, and prints JSON using **`@memorynodeai/sdk`** against **`https://api.memorynode.ai`**.

**Canonical positioning:** [../docs/external/POSITIONING.md](../docs/external/POSITIONING.md)

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

---

## Get an API key

1. Sign up at **[console.memorynode.ai](https://console.memorynode.ai)**.
2. Create a project and an API key.
3. Use it as the `API_KEY` environment variable below.

---

## Quickstart (this folder)

**Prerequisites:** Node.js 20+

From **this folder** (`public-onboarding`):

```bash
npm install
export API_KEY=your_api_key_here
npm start
```

**From the MemoryNode monorepo root** (pnpm workspaces):

```bash
pnpm install
cd public-onboarding
export API_KEY=your_api_key_here
pnpm start
```

**What happens:** The script adds a sample memory, runs a semantic search, and prints the results. You should see `Added memory: <id>` and a `Search results` JSON block. No extra code required — `index.mjs` is ready to run.

**Without cloning the monorepo:** `npm install @memorynodeai/sdk`, copy the pattern from `index.mjs`, set `API_KEY`, and run with Node.

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
- **Limits and scaling:** [../docs/external/README.md](../docs/external/README.md) — usage caps, rate limits, and recipes.

---

## More documentation

- **Full README:** [../README.md](../README.md) (MCP, curl, SDK, examples, trust)
- **Recipes:** [support](../docs/external/RECIPE_SUPPORT_AGENT.md) · [SaaS copilot](../docs/external/RECIPE_SAAS_COPILOT.md) · [SMB](../docs/external/RECIPE_SMB_CHATBOT.md)
- **Guided quickstart:** [../docs/start-here/README.md](../docs/start-here/README.md)
- **Trust:** [../docs/external/TRUST.md](../docs/external/TRUST.md)

---

## License

MIT
