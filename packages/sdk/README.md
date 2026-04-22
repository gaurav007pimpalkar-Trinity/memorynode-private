# @memorynodeai/sdk

Typed client for the MemoryNode REST API and hosted MCP. Source: [packages/sdk/src/index.ts](src/index.ts).

## Install

```bash
npm install @memorynodeai/sdk
```

## Quick start

```ts
import { MemoryNodeClient } from "@memorynodeai/sdk";

const client = new MemoryNodeClient({
  baseUrl: "https://api.memorynode.ai",
  apiKey: process.env.MEMORYNODE_API_KEY!,
  // transport: "hybrid" (default) | "mcp" | "rest"
});

await client.addMemory({
  ownerId: "user_123",
  ownerType: "user",
  text: "Prefers answers in bullet points.",
  memory_type: "preference",
});

const results = await client.search({
  ownerId: "user_123",
  query: "how does the user like answers?",
  topK: 5,
});
```

API key is sent as `Authorization: Bearer <key>`. For PayU billing behavior, plan limits, and rate limits, see [docs/external/API_USAGE.md](../../docs/external/API_USAGE.md).

## Client options

```ts
interface MemoryNodeClientOptions {
  baseUrl?: string;          // default http://127.0.0.1:8787
  apiKey?: string;
  timeoutMs?: number;        // default 60_000
  signal?: AbortSignal;
  maxRetries?: number;       // default 2
  retryBaseMs?: number;      // default 200
  transport?: "mcp" | "rest" | "hybrid";  // default "hybrid"
}
```

Transports:

- `rest` — direct HTTPS to `baseUrl`.
- `mcp` — calls the hosted MCP Streamable HTTP at `<baseUrl>/v1/mcp` (requires `apiKey`).
- `hybrid` — attempts MCP for simple `search` calls; falls back to REST whenever the request uses filters, `explain`, `search_mode`, `min_score`, `retrieval_profile`, `page`, or `page_size`, or when MCP itself errors.

## Method map

Each method is a thin wrapper over an HTTP route in [apps/api/src/router.ts](../../apps/api/src/router.ts). See [docs/external/API_USAGE.md](../../docs/external/API_USAGE.md) for request/response shapes.

### Memories

| SDK method | REST route |
| --- | --- |
| `addMemory(input)` | `POST /v1/memories` |
| `addConversationMemory(input)` | `POST /v1/memories/conversation` |
| `ingest(input)` | `POST /v1/ingest` |
| `listMemories(options?)` | `GET /v1/memories` |
| `getMemory(id)` | `GET /v1/memories/:id` |
| `deleteMemory(id)` | `DELETE /v1/memories/:id` |
| `importMemories(artifactBase64, mode?)` | `POST /v1/import` |

### Search and context

| SDK method | REST route |
| --- | --- |
| `search(options)` | `POST /v1/search` (or MCP `search` tool in `hybrid`/`mcp`) |
| `listSearchHistory(limit?)` | `GET /v1/search/history` |
| `replaySearch({ queryId })` | `POST /v1/search/replay` |
| `context(options)` | `POST /v1/context` |
| `contextExplain(options)` | `GET /v1/context/explain` |
| `sendContextFeedback(options)` | `POST /v1/context/feedback` |
| `explainAnswer(options)` | `POST /v1/explain/answer` |
| `getPruningMetrics()` | `GET /v1/pruning/metrics` |

### Evals

| SDK method | REST route |
| --- | --- |
| `listEvalSets()` | `GET /v1/evals/sets` |
| `createEvalSet({ name })` | `POST /v1/evals/sets` |
| `deleteEvalSet(id)` | `DELETE /v1/evals/sets/:id` |
| `listEvalItems(evalSetId)` | `GET /v1/evals/items?eval_set_id=...` |
| `createEvalItem(input)` | `POST /v1/evals/items` |
| `deleteEvalItem(id)` | `DELETE /v1/evals/items/:id` |
| `runEvalSet(input)` | `POST /v1/evals/run` |

### Usage and audit

| SDK method | REST route |
| --- | --- |
| `getUsageToday()` | `GET /v1/usage/today` |
| `listAuditLog({ page?, limit? })` | `GET /v1/audit/log` |

### Admin (needs `adminToken` per call, sent as `x-admin-token`)

| SDK method | REST route |
| --- | --- |
| `createWorkspace(name, adminToken)` | `POST /v1/workspaces` |
| `createApiKey(workspaceId, name, adminToken)` | `POST /v1/api-keys` |
| `listApiKeys(workspaceId, adminToken)` | `GET /v1/api-keys` |
| `revokeApiKey(apiKeyId, adminToken)` | `POST /v1/api-keys/revoke` |

### Health

| SDK method | REST route |
| --- | --- |
| `health()` | `GET /healthz` |

## Owner identity

`addMemory`, `addConversationMemory`, `search`, `context`, `contextExplain`, `listMemories`, and `runEvalSet` accept `ownerId` + `ownerType` (`user` | `team` | `app`). Legacy `userId` / `entityId` / `entityType` are accepted for back-compat; `entityType: "agent"` is normalized to `"app"`. All provided ids must match or the call throws `MemoryNodeApiError` with code `INVALID_OWNER_ID`.

## Errors

All methods throw `MemoryNodeApiError` on non-2xx responses:

```ts
import { MemoryNodeApiError } from "@memorynodeai/sdk";

try {
  await client.search({ ownerId: "u1", query: "..." });
} catch (err) {
  if (err instanceof MemoryNodeApiError) {
    console.log(err.code, err.message, err.status, err.requestId);
  }
}
```

Codes mirror [docs/external/API_USAGE.md §3](../../docs/external/API_USAGE.md).

## Retry and timeouts

The REST transport ([packages/sdk/src/internal-rest.ts](src/internal-rest.ts)) retries `429`, `5xx`, and fetch-level network errors with exponential backoff (`retryBaseMs * 2^n`, full jitter). `timeoutMs` bounds each individual attempt. `signal` aborts the combined call.

## Re-exports

```ts
import {
  MemoryNodeClient,
  MemoryNodeApiError,
  MemoryNodeMcpTransport,
  resolveMcpUrl,
  type ApiError,
} from "@memorynodeai/sdk";
```
