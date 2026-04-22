<p align="center">
  <strong>MemoryNode.ai</strong>
</p>

<p align="center">
  <strong>Per-user memory for AI apps — store, search, and explain what was remembered.</strong>
</p>

<p align="center">
  <a href="docs/start-here/README.md">Quickstart</a>
  ·
  <a href="docs/external/API_USAGE.md">API reference</a>
  ·
  <a href="https://console.memorynode.ai">Console</a>
  ·
  <a href="docs/start-here/MCP.md">MCP setup</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@memorynodeai/sdk"><img src="https://img.shields.io/npm/v/@memorynodeai/sdk?style=flat-square&color=blue" alt="npm @memorynodeai/sdk" /></a>
  <a href="https://www.npmjs.com/package/@memorynodeai/mcp-server"><img src="https://img.shields.io/npm/v/@memorynodeai/mcp-server?style=flat-square&color=blue" alt="npm @memorynodeai/mcp-server" /></a>
  <a href="docs/external/openapi.yaml"><img src="https://img.shields.io/badge/OpenAPI-docs%2Fexternal%2Fopenapi.yaml-blue?style=flat-square" alt="OpenAPI" /></a>
</p>

---

MemoryNode is a **hosted memory and context layer** for customer-facing AI: support bots, SaaS copilots, and agents that must remember users across sessions. You call **one API** (or **MCP tools**) to save what mattered and recall the right snippets next turn — **without running your own vector database or embedding pipeline**.

**Canonical API behavior** (not marketing copy): [docs/external/API_USAGE.md](docs/external/API_USAGE.md) · [docs/external/openapi.yaml](docs/external/openapi.yaml) (regenerate with `pnpm openapi:gen`). **Positioning and non-goals:** [docs/external/POSITIONING.md](docs/external/POSITIONING.md).

| | |
| --- | --- |
| **Memory API** | Store text and metadata per user and scope; optional extraction; chunking handled for you. |
| **Hybrid search** | Vector + keyword + reranking over your workspace memories (`POST /v1/search`). |
| **Context packs** | Prompt-ready blocks from search + policy (`POST /v1/context`). |
| **Explainability** | See why a chunk ranked (`GET /v1/context/explain`) — debug retrieval without guesswork. |
| **MCP-native** | Hosted Streamable HTTP MCP and a published **stdio** server for Cursor, Claude Code, and similar clients. |

---

## Choose your path

<table>
<tr>
<td width="50%" valign="top">

### I am shipping an AI product

Add **durable per-user memory** with REST or the **TypeScript SDK** from your backend. Use **scopes** and filters for multi-tenant SaaS.

**→ [docs/external/API_USAGE.md](docs/external/API_USAGE.md)** · **→ [packages/sdk/README.md](packages/sdk/README.md)**

</td>
<td width="50%" valign="top">

### I want memory inside my editor or agent

Wire **MCP** so your assistant can **save**, **recall**, and inject **context** with policy guardrails — no wrapper around every HTTP call.

**→ [docs/start-here/MCP.md](docs/start-here/MCP.md)** · **→ [packages/mcp-server/README.md](packages/mcp-server/README.md)**

</td>
</tr>
</table>

---

## Give your AI memory (MCP)

Hosted MCP (Streamable HTTP) is intended for MCP clients that support remote servers. The **stdio** package is for local tooling.

### Install (stdio package)

```bash
pnpm add @memorynodeai/mcp-server
# or
npm install @memorynodeai/mcp-server
```

After install, run the **`memorynode-mcp`** binary with `MEMORYNODE_API_KEY` and `MEMORYNODE_BASE_URL` set — see [docs/MCP_SERVER.md](docs/MCP_SERVER.md).

### Hosted MCP (manual config)

Point your client at the hosted endpoint and pass your project API key:

```json
{
  "mcpServers": {
    "memorynode": {
      "url": "https://mcp.memorynode.ai/mcp",
      "headers": {
        "Authorization": "Bearer mn_live_your_api_key_here"
      }
    }
  }
}
```

Some clients also accept **`https://api.memorynode.ai/v1/mcp`** with the same `Authorization` header — see [docs/MCP_SERVER.md](docs/MCP_SERVER.md) for transport notes.

### Tools (canonical)

| Tool | What it does |
| --- | --- |
| `memory` | Save or forget information; hosted path supports confirmation for destructive forgets. |
| `recall` | Semantic recall over memories for the current scope. |
| `context` | Structured context for the model (search + list paths per policy). |
| `whoAmI` | Identity / workspace slice the server is using. |

Deprecated aliases (`memory_insert`, `memory_search`, `memory_context`, etc.) remain for migration; prefer the names above. Policy envelopes include stable codes — see [docs/MCP_SERVER.md](docs/MCP_SERVER.md).

---

## Build with MemoryNode (API + SDK)

### Install

```bash
npm install @memorynodeai/sdk
```

### TypeScript quickstart

```typescript
import { MemoryNodeClient } from "@memorynodeai/sdk";

const client = new MemoryNodeClient({
  apiKey: process.env.API_KEY!,
  baseUrl: "https://api.memorynode.ai",
});

await client.addMemory({
  userId: "user-1",
  namespace: "default",
  text: "User prefers dark mode and TypeScript",
});

const results = await client.search({
  userId: "user-1",
  namespace: "default",
  query: "preferences",
  topK: 5,
});

const ctx = await client.context({
  userId: "user-1",
  namespace: "default",
  query: "What do we know about UI preferences?",
  topK: 5,
});
```

### Python (HTTP) quickstart

Use any HTTP client; this mirrors [examples/python-quickstart](examples/python-quickstart/README.md) (`httpx`).

```python
import os
import httpx

base = os.environ["BASE_URL"]  # https://api.memorynode.ai
key = os.environ["API_KEY"]
headers = {"Authorization": f"Bearer {key}", "content-type": "application/json"}

with httpx.Client(base_url=base, headers=headers, timeout=30.0) as http:
    http.post("/v1/memories", json={
        "userId": "user-1",
        "scope": "default",
        "text": "User prefers dark mode",
    })
    r = http.post("/v1/search", json={
        "userId": "user-1",
        "scope": "default",
        "query": "theme preference",
        "top_k": 5,
    })
    print(r.json())
```

### curl (hosted API)

```bash
export API_KEY=mn_live_xxx
curl -sS -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"user-1","scope":"default","text":"User prefers dark mode"}'
curl -sS -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"user-1","scope":"default","query":"theme preference","top_k":5}'
curl -sS -X POST "https://api.memorynode.ai/v1/context" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"user-1","scope":"default","query":"What do we know about theme preferences?"}'
curl -sS -G "https://api.memorynode.ai/v1/context/explain" \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode "userId=user-1" \
  --data-urlencode "scope=default" \
  --data-urlencode "query=What do we know about theme preferences?" \
  --data-urlencode "top_k=5"
```

**Step-by-step (about 10 minutes):** [docs/start-here/README.md](docs/start-here/README.md)

---

## API at a glance

| Surface | Purpose |
| --- | --- |
| `POST /v1/memories` | Create a memory (text, metadata, optional extraction). |
| `POST /v1/search` | Hybrid search with filters and modes. |
| `POST /v1/context` | Build prompt-ready context from retrieval. |
| `GET /v1/context/explain` | Per-chunk rationale for why context matched. |
| `GET /v1/usage/today` | Usage snapshot for caps and dashboards. |

Full route list and enums: [docs/external/API_USAGE.md](docs/external/API_USAGE.md).

---

## How it fits together

```
Your app or MCP client
        │
        │  HTTPS + API key (REST)  or  MCP transport
        ▼
┌───────────────────────────────────────────────┐
│  MemoryNode API (hosted: api.memorynode.ai)    │
│  • Auth + workspace isolation                  │
│  • Embeddings + chunking (managed)             │
│  • Hybrid search + context + explain           │
│  • Usage caps and plan gates (atomic reserves) │
└───────────────────────────────────────────────┘
        │
        ▼
  JSON memories, scores, and explain traces
  → Inject into system prompt, tools, or UI
```

**Memory is not the same as “dump everything into RAG.”** MemoryNode is optimized for **per-user, per-scope** facts you can search and **justify** when something surfaces in context. Pair with your own docs RAG if you need both.

---

## Examples and recipes

| Path | Description |
| --- | --- |
| [examples/node-quickstart](examples/node-quickstart/README.md) | Node + SDK |
| [examples/python-quickstart](examples/python-quickstart/README.md) | Python + HTTP |
| [examples/nextjs-middleware](examples/nextjs-middleware/README.md) | Next.js |
| [examples/langchain-wrapper](examples/langchain-wrapper/README.md) | LangChain-style adapter |
| [examples/support-bot-minimal](examples/support-bot-minimal/README.md) | Minimal support bot |
| [docs/external/RECIPE_SUPPORT_AGENT.md](docs/external/RECIPE_SUPPORT_AGENT.md) | Support agent recipe |
| [docs/external/RECIPE_SAAS_COPILOT.md](docs/external/RECIPE_SAAS_COPILOT.md) | SaaS copilot recipe |
| [docs/external/RECIPE_SMB_CHATBOT.md](docs/external/RECIPE_SMB_CHATBOT.md) | SMB chatbot recipe |

**Minimal public quickstart folder:** [public-onboarding/README.md](public-onboarding/README.md) (standalone `npm start` against the hosted API).

**Public GitHub mirror** ([memorynode](https://github.com/gaurav007pimpalkar-Trinity/memorynode)): curated copy only — run `pnpm sync:public-github` from this repo, then push per [docs/internal/PUBLIC_GITHUB_MIRROR.md](docs/internal/PUBLIC_GITHUB_MIRROR.md).

---

## Trust and security

- [docs/external/TRUST.md](docs/external/TRUST.md) — customer-facing trust summary  
- [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md) — retention and deletion  
- [docs/SECURITY.md](docs/SECURITY.md) — security practices  
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities  

---

## Self-host and contributors

| Path | Description |
| --- | --- |
| [docs/self-host/README.md](docs/self-host/README.md) | Self-host overview |
| [docs/self-host/LOCAL_DEV.md](docs/self-host/LOCAL_DEV.md) | Local dev, stub mode, first run |

**Local development (monorepo):** `pnpm dev:stub` runs preflight then starts the API with Wrangler (see [docs/self-host/LOCAL_DEV.md](docs/self-host/LOCAL_DEV.md)). `pnpm preflight:dev` validates `.dev.vars` without starting the server.

**Repository layout**

| Path | Description |
| --- | --- |
| `apps/api` | HTTP API (Cloudflare Worker) |
| `apps/dashboard` | Web console |
| `packages/sdk` | TypeScript SDK |
| `packages/mcp-server` | MCP stdio server |
| `packages/mcp-core` | Shared MCP registry / policy wiring |
| `packages/shared` | Shared types, plans, MCP policy |
| `packages/cli` | CLI tooling |
| `docs/start-here` | Onboarding and MCP |
| `docs/external` | REST reference, OpenAPI, recipes |
| `docs/self-host` | Local and private deploy |

Internal runbooks: [docs/internal/README.md](docs/internal/README.md). **Doc inventory:** [docs/DOCUMENTATION_INDEX.md](docs/DOCUMENTATION_INDEX.md).

**Docs CI:** `pnpm openapi:check` keeps OpenAPI aligned with the generator; `pnpm check:docs-drift` enforces truth-doc updates for mapped surfaces. Override only when justified: `DOCS_DRIFT_ALLOW=1` (CI logs `PR_BODY`). Details: `scripts/check_docs_drift.mjs`.

---

<p align="center">
  <strong>Give your AI app a memory it can defend.</strong>
</p>
