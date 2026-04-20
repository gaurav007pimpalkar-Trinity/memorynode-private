# @memorynodeai/sdk

## ⚠️ Source of Truth

This document must always reflect actual SDK surface (`packages/sdk/src/index.ts`) and HTTP routes.

If code changes:

→ This document **MUST** be updated in the same PR.

Do not merge changes that break this alignment.

---

Official JavaScript/TypeScript client for **MemoryNode**. Use it from your **backend** only (never ship API keys to browsers in production).

**REST reference:** [docs/external/API_USAGE.md](../../docs/external/API_USAGE.md) · **Contracts / routes:** `apps/api/src/contracts/`, `apps/api/src/router.ts`.

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

await client.addMemory({
  userId: "user-1",
  namespace: "default", // maps to API `scope` / `namespace`
  text: "Prefers dark mode",
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
  query: "What do we know about preferences?",
  topK: 5,
});
```

## `MemoryNodeClient` methods

All methods use your **`apiKey`** from the constructor unless noted.

| Method | HTTP | Notes |
|--------|------|------|
| `health()` | `GET /healthz` | No API key required. |
| `addMemory` | `POST /v1/memories` | Supports `memory_type`, `extract`, `chunk_profile`, owner fields — see types. |
| `addConversationMemory` | `POST /v1/memories/conversation` | Transcript or `messages[]`. |
| `ingest` | `POST /v1/ingest` | Discriminated `kind` + `body`. |
| `search` | `POST /v1/search` | `searchMode`, `minScore`, `memoryType` filters, `explain`. |
| `listSearchHistory` | `GET /v1/search/history` | Optional limit. |
| `replaySearch` | `POST /v1/search/replay` | `queryId` from history. |
| `context` | `POST /v1/context` | Same options as `search` for query body. |
| `contextExplain` | `GET /v1/context/explain` | Query-string explain API. |
| `sendContextFeedback` | `POST /v1/context/feedback` | Retrieval trace feedback. |
| `getPruningMetrics` | `GET /v1/pruning/metrics` | |
| `explainAnswer` | `POST /v1/explain/answer` | Question + context text. |
| `listMemories` | `GET /v1/memories` | Pagination + filters. |
| `getMemory` | `GET /v1/memories/:id` | |
| `deleteMemory` | `DELETE /v1/memories/:id` | |
| `importMemories` | `POST /v1/import` | Paid plans; artifact base64 + mode. |
| `getUsageToday` | `GET /v1/usage/today` | |
| `listAuditLog` | `GET /v1/audit/log` | Optional `page`, `limit`. |

**Evals:** `listEvalSets`, `createEvalSet`, `deleteEvalSet`, `listEvalItems`, `createEvalItem`, `deleteEvalItem`, `runEvalSet`.

**Admin (pass `adminToken` per call — `x-admin-token`, not the project API key):** `createWorkspace`, `createApiKey`, `listApiKeys`, `revokeApiKey`.

**Not in SDK:** billing (`/v1/billing/status`, `/v1/billing/checkout`), workspace webhooks, dashboard session cookies, hosted MCP HTTP — use `fetch` or your HTTP client.

## Links

- **GitHub:** [github.com/gaurav007pimpalkar-Trinity/memorynode](https://github.com/gaurav007pimpalkar-Trinity/memorynode)
- **Docs:** [docs.memorynode.ai](https://docs.memorynode.ai)

## License

MIT
