# API usage

## ⚠️ Source of Truth

This document must always reflect actual system behavior.

If code changes:

→ This document **MUST** be updated in the same PR.

Do not merge changes that break this alignment.

---

How to call the MemoryNode Worker API. Base URL: `https://api.memorynode.ai` (or your deployment).

**Authoritative code:** route table `apps/api/src/router.ts`; session + MCP entry `apps/api/src/workerApp.ts`; request bodies `apps/api/src/contracts/`. **Machine-readable:** `docs/external/openapi.yaml` (run `pnpm openapi:gen` after changing `apps/api/scripts/generate_openapi.mjs`).

---

## Read order (recommended)

1. [../start-here/README.md](../start-here/README.md)
2. [../start-here/PER_USER_MEMORY.md](../start-here/PER_USER_MEMORY.md)
3. [../start-here/SCOPES.md](../start-here/SCOPES.md)
4. [../start-here/ADVANCED_ISOLATION.md](../start-here/ADVANCED_ISOLATION.md)
5. This page for full REST coverage.

---

## Authentication (API key routes)

On every request:

- `Authorization: Bearer <api_key>` **or**
- `x-api-key: <api_key>`

Responses include `x-request-id`. Include it when contacting support.

**Exceptions (no project API key):**

- `POST /v1/webhooks/memory` — HMAC-signed body (see below).
- `POST /v1/billing/webhook` — PayU callback (platform signature).
- `POST /v1/dashboard/session` and `POST /v1/dashboard/logout` — browser session + Supabase access token (see [Dashboard session](#dashboard-session-console)).
- Admin routes require `x-admin-token` (see [Admin & control plane](#admin--control-plane)).

---

## Terminology (wire format)

| Concept | Fields | Notes |
|--------|--------|------|
| End-user id | `userId` **or** `user_id` | Accept either; same for list/search query params. |
| Scope / container | `scope`, `namespace`, or `containerTag` | Aliases; resolved to a single namespace string server-side. |
| Owner typing | `owner_id`, `owner_type`, legacy `entity_id`, `entity_type` | Must agree when multiple set; see contracts. |
| Memory types | `memory_type` | `fact`, `preference`, `event`, `note`, `task`, `correction`, `pin` (see `MEMORY_TYPES` in `apps/api/src/contracts/search.ts`). |

If no user/owner id is provided, routing falls back to shared app isolation (`shared_app` / `shared_default` behavior); see [ADVANCED_ISOLATION.md](../start-here/ADVANCED_ISOLATION.md).

---

## Public API — core

### Store a memory

**`POST /v1/memories`**

Body (subset; full schema in contracts): `text` (required), identity fields above, optional `metadata`, `memory_type`, `importance`, `chunk_profile` (`balanced` \| `dense` \| `document`), `extract` (default true), `effective_at`, `replaces_memory_id`, `idempotency_key`.

Response on 200: `stored: true`, optional `chunks`, optional `embedding: "skipped_due_to_budget"`, `extraction` status object, optional intelligence fields.

### Conversation ingest

**`POST /v1/memories/conversation`**

Provide non-empty `transcript` **or** `messages[]` with `{ role, content, at? }` where `role` is `user` \| `assistant` \| `system` \| `tool`, plus the same identity fields as `POST /v1/memories`.

### Unified ingest

**`POST /v1/ingest`**

Discriminated `kind`:

- `memory` → body matches memory insert.
- `conversation` → body matches conversation insert.
- `document` → body matches memory insert; default `chunk_profile` is `document` if omitted (see contracts).
- `bundle` → body matches import (`artifact_base64`, `mode`, …).

### List / get / delete

- **`GET /v1/memories`** — Query: `page`, `page_size`, `user_id`, `owner_id`, `entity_id`, `owner_type`, `entity_type`, `namespace`, `memory_type`, `metadata` (JSON string), `start_time`, `end_time`.
- **`GET /v1/memories/{uuid}`** — `:id` must be a UUID.
- **`DELETE /v1/memories/{uuid}`**

### Typed links (graph-lite)

- **`POST /v1/memories/{uuid}/links`** — Body: `{ "to_memory_id": "<uuid>", "link_type": "related_to" | "about_ticket" | "same_topic" }`. Max **20** outbound links per source memory (`MAX_OUTBOUND_LINKS` in `handlers/memoryLinks.ts`).
- **`DELETE /v1/memories/{uuid}/links?to_memory_id=&link_type=`**

### Search

**`POST /v1/search`**

Body matches `SearchPayloadSchema` in contracts: `query` (required), identity/namespace fields, optional `top_k`, `page`, `page_size`, `explain`, `search_mode` (`hybrid` \| `vector` \| `keyword`), `min_score`, `retrieval_profile` (`balanced` \| `recall` \| `precision`), optional `filters` (`metadata`, `start_time`, `end_time`, `memory_type` as value or array, `filter_mode` `and` \| `or`).

### Search history & replay

- **`GET /v1/search/history`** — Optional query `limit` (capped).
- **`POST /v1/search/replay`** — Body: `{ "query_id": "<uuid>" }`.

### Context (prompt-ready)

**`POST /v1/context`**

Same body shape as search. Returns `context_text`, `citations`, pagination fields, optional `context_blocks`, bounded `profile`, optional `linked_memories`.

### Profile pins

**`PATCH /v1/profile/pins`**

Body includes `memory_ids` (≤10 UUIDs) plus identity/scope fields per `ProfilePinsPatchSchema`. Replaces pinned set for that scope.

### Context explain (debug)

**`GET /v1/context/explain`**

Query params include `query` (required) and identity fields (`userId`, `user_id`, `owner_id`, `scope`, `namespace`, …), plus optional `top_k`, `page`, `page_size`, `search_mode`, `min_score`, `retrieval_profile`.

### Context feedback

**`POST /v1/context/feedback`**

Body: `trace_id` (required), optional `query_id`, `eval_set_id`, `chunk_ids_used`, `chunk_ids_unused` (see `ContextFeedbackRequest` in `@memorynodeai/shared`).

### Pruning metrics

**`GET /v1/pruning/metrics`** — Workspace pruning/dedupe counters.

### Explain answer

**`POST /v1/explain/answer`**

Body: `{ "question": "...", "context": "..." }` — see `ExplainAnswerRequest` in shared types.

---

## Usage, audit, dashboard aggregates

- **`GET /v1/usage/today`** — Usage vs caps for the authenticated workspace key.
- **`GET /v1/audit/log`** — Paginated API audit trail (`page`, `limit` query params).
- **`GET /v1/dashboard/overview-stats`** — Console aggregates; optional `range=1d|7d|30d|all`.

---

## Connectors

- **`GET /v1/connectors/settings`**
- **`PATCH /v1/connectors/settings`** — Partial update per connector row (`connector_id`, `sync_enabled`, `capture_types`).

---

## Import

**`POST /v1/import`**

Body: `artifact_base64`, optional `mode`: `upsert` \| `skip_existing` \| `error_on_conflict` \| `replace_ids` \| `replace_all` (see `ImportPayloadSchema`).

Free plans: **402** upgrade required when blocked.

---

## Billing (PayU)

- **`GET /v1/billing/status`** — Includes legacy `plan`, `plan_status`, and **`effective_plan`** for quotas/display. **`effective_plan` may be `launch` \| `build` \| `deploy` \| `scale` \| `scale_plus`** when derived from entitlements.
- **`POST /v1/billing/checkout`** — Starts checkout. Optional body fields include `plan`, `firstname`, `email`, `phone`. **`plan` must be one of `launch`, `build`, `deploy`, `scale`** (`CHECKOUT_PLAN_IDS` in `handlers/billing.ts`). **`scale_plus` is not a checkout value** — it appears only as a possible **effective_plan** after billing/entitlements reconciliation, not as a PayU checkout selector.
- **`POST /v1/billing/portal`** — Returns **410 Gone** (legacy self-serve portal removed).
- **`POST /v1/billing/webhook`** — PayU server-to-server callback (not called with your API key).

---

## Memory ingest webhook

**`POST /v1/webhooks/memory`**

Does **not** use the normal API key. Configure workspace webhook + `signing_secret`; send payload compatible with **`POST /v1/memories`** plus **`workspace_id`**; header **`X-MN-Webhook-Signature: sha256=<hex>`** where hex = HMAC-SHA256(secret, raw body bytes). Worker env **`MEMORY_WEBHOOK_INTERNAL_TOKEN`** gates internal forward path when configured.

---

## Evaluation API

Authenticated with project API key like other `/v1/*` routes:

- **`GET /v1/evals/sets`** / **`POST /v1/evals/sets`** — List / create set (`name`).
- **`DELETE /v1/evals/sets/{uuid}`**
- **`GET /v1/evals/items?eval_set_id=`** / **`POST /v1/evals/items`**
- **`DELETE /v1/evals/items/{uuid}`**
- **`POST /v1/evals/run`** — Body per `EvalRunSchema` (`eval_set_id`, identity fields, `namespace`, `top_k`, `search_mode`, `min_score`).

---

## Dashboard session (console)

Used by `apps/dashboard` with Supabase login — **cookie** session, not the API key.

- **`POST /v1/dashboard/session`** — Body: `{ "access_token": "<supabase jwt>", "workspace_id": "<uuid>" }`. Sets session cookie; response may include `csrf_token` for mutating calls.
- **`POST /v1/dashboard/logout`** — Sends `x-csrf-token` when session exists. **200** `{ "ok": true }` and cleared session cookie.

CORS: production requires `ALLOWED_ORIGINS` to include the console origin.

### Memory Lab (Developer Console)

The signed-in **Memory Lab** in the dashboard uses the same REST behavior as product integrations: **`POST /v1/search`**, **`POST /v1/context`**, optional **explain** and advanced routes (search history, replay, evals, context feedback) as listed in this document. Browser calls use the **dashboard session** (cookie + CSRF on writes), not `Authorization: Bearer`. In-app “copy as curl” helpers show an equivalent API-key request shape for debugging.

---

## Hosted MCP

Streamable HTTP MCP on the same Worker:

- **`GET` / `POST` / `DELETE`** `https://api.memorynode.ai/v1/mcp` (also `/mcp` on dedicated host). **Authorization: Bearer** project API key. Details: [../MCP_SERVER.md](../MCP_SERVER.md).

---

## Admin & control plane

**`x-admin-token`** header (master admin secret):

- **`POST /v1/workspaces`** — Create workspace.
- **`POST /v1/api-keys`**, **`GET /v1/api-keys?workspace_id=`**, **`POST /v1/api-keys/revoke`**

**Cron / operational (admin token + IP controls per deployment):**

- `POST /admin/webhooks/reprocess`
- `POST /admin/usage/reconcile`
- `POST /admin/sessions/cleanup`
- `POST /admin/memory-hygiene`
- `POST /admin/memory-retention`

**Read-only diagnostics:**

- **`GET /v1/admin/billing/health`**
- **`GET /v1/admin/founder/phase1`**

In **RLS-first / service-role-disabled** modes some paths return **503** — see `workerApp.ts` `CONTROL_PLANE_ONLY`.

---

## Health checks (no API key)

- **`GET /healthz`**, **`GET /v1/health`**
- **`GET /ready`** — Deep check (database).

---

## Errors

JSON shape: `{ "error": { "code": "...", "message": "..." }, "request_id": "..." }` (some errors omit fields).

| HTTP | Meaning |
|------|---------|
| 400 | Validation / bad parameters |
| 401 | Missing or invalid API key |
| 402 | Plan / entitlement / upgrade required |
| 403 | Permission denied (e.g. CSRF) |
| 404 | Unknown route or resource |
| 410 | Gone (`/v1/billing/portal`) |
| 429 | Rate limited — honor `Retry-After` when present |
| 503 | Billing disabled, control-plane disabled, or dependency unavailable |

---

## TypeScript SDK

Package `@memorynodeai/sdk` — class **`MemoryNodeClient`** (`packages/sdk/src/index.ts`):

**API key methods:** `health`, `addMemory`, `addConversationMemory`, `ingest`, `search`, `listSearchHistory`, `replaySearch`, `context`, `contextExplain`, `sendContextFeedback`, `getPruningMetrics`, `explainAnswer`, `listMemories`, `getMemory`, `deleteMemory`, `importMemories`, `getUsageToday`, `listAuditLog`, `listEvalSets`, `createEvalSet`, `deleteEvalSet`, `listEvalItems`, `createEvalItem`, `deleteEvalItem`, `runEvalSet`.

**Admin token methods:** `createWorkspace`, `createApiKey`, `listApiKeys`, `revokeApiKey`.

Billing checkout/status are **not** wrapped in the SDK; call **`GET/POST /v1/billing/*`** with `fetch` or your HTTP client from a trusted backend.

See [../../packages/sdk/README.md](../../packages/sdk/README.md).
