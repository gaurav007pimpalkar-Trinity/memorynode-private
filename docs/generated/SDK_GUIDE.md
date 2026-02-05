# SDK Guide (@memorynode/sdk)

## Install
- Monorepo uses pnpm; SDK depends on shared workspace package. From repo root: `corepack pnpm install` (`package.json`, `pnpm-workspace.yaml`).
- SDK package located at `packages/sdk`; build script `pnpm --filter @memorynode/sdk build` (from `packages/sdk/package.json`).

## Initialization
```ts
import { MemoryNodeClient } from "@memorynode/sdk";

const client = new MemoryNodeClient({
  baseUrl: "http://127.0.0.1:8787", // default if omitted
  apiKey: "<your_api_key>",         // optional for admin calls supply via header below
});
```
Source: `packages/sdk/src/index.ts` (constructor sets default base URL).

## Auth Headers
- API calls use `x-api-key` or `Authorization: Bearer <key>` added automatically when `apiKey` provided (`packages/sdk/src/index.ts`, `buildHeaders`).
- Admin calls require `x-admin-token` passed per call via method parameter (each admin method accepts `adminToken` and sets header in `request`).

## Public Methods (behavior)
- Admin:
  - `createWorkspace(name, adminToken)` → POST `/v1/workspaces`; returns `{ workspace_id, name }`.
  - `createApiKey(workspaceId, name, adminToken)` → POST `/v1/api-keys`.
  - `listApiKeys(workspaceId, adminToken)` → GET `/v1/api-keys?workspace_id=...`.
  - `revokeApiKey(apiKeyId, adminToken)` → POST `/v1/api-keys/revoke`.
- Health/Usage:
  - `health()` → GET `/healthz`.
  - `getUsageToday()` → GET `/v1/usage/today`.
- Memories/Search:
  - `addMemory({ userId, namespace?, text, metadata? })` → POST `/v1/memories`.
  - `search(options)` → POST `/v1/search`.
  - `context(options)` → POST `/v1/context`.
  - `listMemories(options)` → GET `/v1/memories` with query params (page, namespace, user_id, metadata, start/end time).
  - `getMemory(id)` → GET `/v1/memories/:id`.
  - `deleteMemory(id)` → DELETE `/v1/memories/:id`.
- Export/Import:
  - `exportMemories()` → POST `/v1/export` (JSON artifact).
  - `exportMemoriesZip()` → POST `/v1/export` with Accept zip, returns `Uint8Array`.
  - `importMemories(artifactBase64, mode?)` → POST `/v1/import`.

Return types derive from `packages/shared/src/index.ts` (AddMemoryResponse, SearchResponse, ContextResponse, MemoryRecord, Export/Import responses, UsageTodayResponse, API key responses).

## Examples
```ts
// Ingest then search
const mem = await client.addMemory({ userId: "u1", text: "hello world", namespace: "default" });
const results = await client.search({ userId: "u1", query: "hello", namespace: "default", topK: 5 });

// Context
const ctx = await client.context({ userId: "u1", query: "hello", namespace: "default" });

// Export / Import
const artifact = await client.exportMemories();
await client.importMemories(artifact.artifact_base64, "upsert");
```
Behavior backed by `packages/sdk/src/index.ts` methods and shared types.

## Error Handling
- On non-2xx, `request` parses response JSON if possible and throws an Error augmented with `{ code, message, status }` from the API (`packages/sdk/src/index.ts`, `toApiError`).
- 204 responses return `undefined` as typed in SDK (`packages/sdk/src/index.ts`, `request`).
