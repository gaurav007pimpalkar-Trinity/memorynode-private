# API Reference (Implemented)
Auth unless stated: API key via header `x-api-key: <key>` or `Authorization: Bearer <key>` validated in `authenticate` (`apps/api/src/index.ts:1185-1235`). Admin plane uses `x-admin-token`. Errors follow `{ "error": { "code": string, "message": string } }`.

## Health
- **GET /healthz** — No auth. Returns `{ "status": "ok" }` (`apps/api/src/index.ts:430-438`). Status: 200.

## Memories
- **POST /v1/memories** — Body `{ user_id, text, namespace?, metadata? }`. Enforces `MAX_TEXT_CHARS`, per-route body limit (`apps/api/src/index.ts:373-392, 830-930`). On success `{ memory_id, chunks }`. Errors: 400 missing/oversize; 402 caps via `checkCapsAndMaybeRespond`; 413 body too large; 429 rate limit; 500 DB/embedding. Example (smoke): `{"user_id":"smoke-user","text":"hello"}` -> 200 with `memory_id` (`scripts/smoke.ps1`).
- **GET /v1/memories** — Query `page`, optional `page_size`, `namespace`, `user_id`, `metadata` (JSON string), `start_time`, `end_time`. Returns `{ results, page, page_size, total, has_more }` (`apps/api/src/index.ts:955-987`). Errors: 400 invalid filter/time; 429 rate limit.
- **GET /v1/memories/:id** — Returns memory record (`apps/api/src/index.ts:988-1021`). 404 if not found. Errors: 429, 500.
- **DELETE /v1/memories/:id** — Deletes memory and chunks via `deleteMemoryCascade` (`apps/api/src/index.ts:1027-1050, 2290-2308`). Returns `{ deleted: boolean, id }`. Errors: 429, 500.

## Search & Context
- **POST /v1/search** — Body `{ user_id, query, namespace?, top_k?, page?, page_size?, filters?{metadata?, start_time?, end_time?} }`. Runs hybrid RRF over RPCs `match_chunks_vector/text` (`infra/sql/002_rpc.sql`). Response `{ results, page, page_size, total, has_more }` (`apps/api/src/index.ts:1052-1110, 1905-2055`). Errors: 400 invalid query/filters; 402 caps; 413 if body too large; 429 rate limit; 500 DB/embedding.
- **POST /v1/context** — Same request schema; returns `{ context_text, citations[{i,chunk_id,memory_id,chunk_index}], page, page_size, total, has_more }` (`apps/api/src/index.ts:1113-1175`). Errors mirror search.

## Usage
- **GET /v1/usage/today** — Returns `{ day, writes, reads, embeds, plan, limits }` (`apps/api/src/index.ts:2634-2664`). Errors: 429 rate limit.

## Billing
- **GET /v1/billing/status** — API key; requires Stripe env in prod. Returns `{ plan, plan_status, effective_plan, current_period_end, cancel_at_period_end }` (`apps/api/src/index.ts:2667-2726`). Errors: 400 missing Stripe config; 429 rate limit; 500 DB.
- **POST /v1/billing/checkout** — Body optional `{ plan: "pro"|"team" }`; creates Stripe Checkout session, returns session info (structure from Stripe client). Uses idempotency header passthrough (`apps/api/src/index.ts:2729-2798`). Errors: 400 missing env; 402 caps; 409 customer/portal state; 429 rate limit; 500 Stripe/DB.
- **POST /v1/billing/portal** — Opens billing portal; 409 if no customer/session (`apps/api/src/index.ts:2801-2866`). Errors: 400 missing env; 429; 500.
- **POST /v1/billing/webhook** — No API key; verifies Stripe signature against raw body; stores to `stripe_webhook_events` table (`apps/api/src/index.ts:2869-2977`, `infra/sql/016_webhook_events.sql`). Errors: 400 invalid signature; 200 even when workspace not found; 500 unexpected.

## Admin (Control Plane, `x-admin-token`)
- **POST /v1/workspaces** — Body `{ name }`; returns `{ workspace_id, name }` (`apps/api/src/index.ts:2365-2414`). Errors: 401 admin auth; 429 rate limit; 500 DB.
- **POST /v1/api-keys** — Body `{ workspace_id, name }`; returns `{ api_key, api_key_id, workspace_id, name }` (`apps/api/src/index.ts:2417-2467`). Errors: 401; 409 salt mismatch; 429; 500.
- **GET /v1/api-keys?workspace_id=...** — Lists keys (masked) (`apps/api/src/index.ts:2470-2508`). Errors: 401; 429; 500.
- **POST /v1/api-keys/revoke** — Body `{ api_key_id }`; returns `{ revoked: true }` (`apps/api/src/index.ts:2511-2547`). Errors: 401; 429; 500.

## Export / Import
- **POST /v1/export** — Optional Accept `application/zip` or `?format=zip`. Returns JSON `{ artifact_base64, bytes, sha256 }` or ZIP archive; manifest v1 enforced (`apps/api/src/index.ts:1540-1635, 2585-2599`). Errors: 413 exceeds `MAX_EXPORT_BYTES`; 429; 500 DB.
- **POST /v1/import** — Body `{ artifact_base64, mode? }` (allowed `upsert|skip_existing|error_on_conflict|replace_ids|replace_all`). Returns `{ imported_memories, imported_chunks }` (`apps/api/src/index.ts:1608-1695, 2606-2631`). Errors: 400 invalid mode/manifest; 403 workspace mismatch; 413 size; 429; 500 DB.

## Rate Limit Behavior
- If over limit: `429` with headers `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `retry-after` from Durable Object response (`apps/api/src/index.ts:2295-2317`; `apps/api/src/rateLimitDO.ts`).

## Error Shape
- All errors use `jsonResponse` format `{ "error": { "code": string, "message": string, ...optional fields } }` (`apps/api/src/index.ts:214-234, 520-550`). Specific codes include `BAD_REQUEST`, `UNAUTHORIZED`, `RATE_LIMITED`, `CAP_EXCEEDED`, `CONFIG_ERROR`, `DB_ERROR`, `EMBED_ERROR`, `PAYLOAD_TOO_LARGE`, `NOT_FOUND`.
