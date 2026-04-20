# API usage

How to call the MemoryNode API and what to expect. Base URL: `https://api.memorynode.ai` (or your deployment’s URL).

These endpoints are aimed at **product builders** (per-user memory, transcripts, light graph links, webhooks). They intentionally avoid enterprise-only governance (approval queues, SIEM exports, legal hold, org-wide SaaS sync).

## Read order (recommended)

If you are new, read in this order:

1. [../start-here/README.md](../start-here/README.md)
2. [../start-here/PER_USER_MEMORY.md](../start-here/PER_USER_MEMORY.md)
3. [../start-here/SCOPES.md](../start-here/SCOPES.md)
4. [../start-here/ADVANCED_ISOLATION.md](../start-here/ADVANCED_ISOLATION.md)
5. Then use this page as full reference.

## Authentication

Send your API key on every request:

- Header: `Authorization: Bearer <your_api_key>`
- Or: `x-api-key: <your_api_key>`

Responses include an `x-request-id` header. If you contact support, include that value.

---

## Store a memory

**POST /v1/memories**

Body:

| Field | Required | Description |
|-------|----------|-------------|
| userId | Recommended | Your end-user identifier. Use the same value when you search. |
| user_id | Legacy alias | Backward-compatible alias for `userId`. |
| text | Yes | The memory content. |
| scope | No | Optional logical scope (e.g. support, sales). |
| namespace | Legacy alias | Backward-compatible alias for `scope`. |
| metadata | No | Optional key-value pairs. |
| memory_type | No | Optional tag: `fact`, `preference`, `event`, `note`, `task`, `correction`, or `pin`. |
| chunk_profile | No | Chunking preset for long text: `balanced` (default), `dense`, or **`document`** (larger chunks; use when you already extracted plain text from a PDF/DOCX client-side). |
| effective_at | No | ISO time when the memory becomes retrievable (defaults to now). |
| replaces_memory_id | No | When set, supersedes that memory (server links `duplicate_of` to the new row). |
| extract | No | Defaults to **`true`**. When allowed by plan/budget, runs lightweight LLM extraction to child memories. Set **`false`** to store only the parent memory. |

**Documents (phase A — client-side extract):** For PDF/DOCX, extract text in your app or worker, then `POST /v1/memories` with that text and `chunk_profile: "document"`. Optional `metadata.source: "pdf" | "docx"` helps you filter later. Server-side binary parsing is not required for this path.

Example: `{"userId":"user-123","scope":"myapp","text":"User loves coffee"}`

With typing and extraction: `{"userId":"user-123","text":"I'm vegetarian and visited Paris last week","memory_type":"note","extract":true}`

Response: always includes **`"stored": true`** on HTTP 200 (your row was saved). **`chunks`** is the count of search-indexed segments when embedding ran; it may be omitted when embedding was skipped (e.g. text-only ingest under global AI budget — then **`"embedding": "skipped_due_to_budget"`** appears instead). **`extraction`**: `{ "status": "run" | "degraded" | "skipped" }`; when `status` is `skipped`, a **`reason`** (and optional **`error`**) is included. Headers: **`x-extraction-status`** always; **`x-extraction-reason`** only when skipped (and not `none`).

---

## Conversation ingest

**POST /v1/memories/conversation**

Same auth and isolation headers as other routes. Body: either `transcript` (string) or `messages[]` with `{ role, content, at? }` (roles: `user`, `assistant`, `system`, `tool`), plus the same identity fields as `POST /v1/memories`. The worker normalizes to a single parent `text` row and runs the usual chunk/embed/extract path. Metadata gets `source: "conversation"`.

---

## Unified ingest

**POST /v1/ingest**

Single dispatcher. Body is a discriminated object:

- `{ "kind": "memory", "body": { ...same as POST /v1/memories } }`
- `{ "kind": "conversation", "body": { ...same as /v1/memories/conversation } }`
- `{ "kind": "document", "body": { ...memory body; default `chunk_profile` is `document` if omitted } }`
- `{ "kind": "bundle", "body": { "artifact_base64": "...", "mode": "..." } }` — same as **POST /v1/import**.

---

## List and delete memories

- **GET /v1/memories** — List memories. Query params: `page`, `page_size`, `userId` (or `user_id`), `scope` (or `namespace`), `memory_type` (fact | preference | event | note | task | correction | pin), and optional filters (`metadata`, `start_time`, `end_time`).
- **GET /v1/memories/:id** — Fetch one memory.
- **DELETE /v1/memories/:id** — Delete a memory.

### Typed links (graph-lite)

- **POST /v1/memories/:id/links** — Body: `{ "to_memory_id": "<uuid>", "link_type": "related_to" | "about_ticket" | "same_topic" }`. Same `user_id` / `namespace` as both memories; max **20** outbound links per source memory.
- **DELETE /v1/memories/:id/links?to_memory_id=&link_type=** — Remove one edge.

---

## Search

**POST /v1/search**

Body: `userId`, `query`, and optional `scope`, `top_k`, `page`, `page_size`, `explain`. Use the same `userId` and `scope` as when you stored.

Optional fields:

| Field | Description |
|-------|-------------|
| search_mode | `hybrid` (default), `vector`, or `keyword`. `keyword` avoids embedding usage. |
| min_score | Minimum relevance score 0–1; results below are dropped. |
| filters.memory_type | Single value or array: `fact`, `preference`, `event`, `note`, `task`, `correction`, `pin` (OR semantics). |
| filters.filter_mode | For metadata: `and` (default) or `or`. |

Response: List of matching memories (and optional scores). You can send `"explain": true` to get a short explanation of why each result matched.

---

## Context (for prompts)

**POST /v1/context**

Same body as search (including optional `search_mode`, `min_score`, and `filters.memory_type` / `filters.filter_mode`). Response includes `context_text` (formatted text of relevant memories), `citations`, and optionally `context_blocks` (count after merging adjacent chunks). It also returns a bounded **`profile`** object (`pinned_facts`, `recent_notes`, `preferences`) and optional **`linked_memories`** (one hop from top hits via `memory_links`, capped server-side). Use this to build your AI prompt.

### Profile pins

**PATCH /v1/profile/pins** — Body: `{ "userId", "scope" | "namespace", "memory_ids": ["<uuid>", ...] }` (max 10). Replaces the set of memories with `metadata.pinned: true` for that scope; listed IDs are pinned, others previously pinned in that scope are unpinned.

---

## Context explain (debug retrieval)

**GET /v1/context/explain**

Query params: `userId`, `query`, and optional `scope`, `top_k`, `page`, `page_size`, `search_mode`, `min_score`, `retrieval_profile`.

Response includes:

- `memories_retrieved`
- `chunk_ids_used`
- per-result `scores` with `relevance_score`, `recency_score`, `importance_score`, `final_score`
- `ordering_explanation`

Use this endpoint to understand why memory was ranked and returned.

---

## Usage today

**GET /v1/usage/today**

Returns how much you’ve used today and your plan’s limits. Use it to show usage in your app or to avoid hitting limits.

---

## Billing

- **GET /v1/billing/status** — Current plan and period. Use `effective_plan` from the response for display and limits.
- **POST /v1/billing/checkout** — Start an upgrade. Body: `{"plan": "launch" | "build" | "deploy" | "scale" | "scale_plus"}`. You get a link or form to complete payment.

---

## Import (paid plans)

- **POST /v1/import** — Import from an artifact. Body: `{"artifact_base64": "...", "mode": "upsert" | "skip_existing" | ...}`.
- Free plans receive **402 `UPGRADE_REQUIRED`**.

---

## Memory ingest webhook (Zapier / Make)

**POST /v1/webhooks/memory** — Does **not** use your normal API key. Configure a row in `memory_ingest_webhooks` (migration `062_memory_ingest_webhooks.sql`) with a **`signing_secret`** per workspace. Send the same JSON as **`POST /v1/memories`** plus **`workspace_id`**, and header **`X-MN-Webhook-Signature: sha256=<hex>`** where the hex is **HMAC-SHA256(signing_secret, raw_request_body)** over the exact bytes you POST. The deployment must also set **`MEMORY_WEBHOOK_INTERNAL_TOKEN`** (worker env) so the server can safely forward into the standard memory write path after verification. Rate limits apply per IP and per workspace.

This route is separate from **POST /v1/billing/webhook** (PayU).

---

## Routing defaults

If `userId` is omitted, MemoryNode routes to a shared app bucket (`shared_default`) instead of per-user isolation.
Use that path only for global memory, not personalized memory.

For full routing precedence and debug-header policy, see [../start-here/ADVANCED_ISOLATION.md](../start-here/ADVANCED_ISOLATION.md).

## Errors and what to do

Responses use: `{"error": {"code": "...", "message": "..."}, "request_id": "..."}`.

| Status | What to do |
|--------|------------|
| **401** | Your API key is missing, wrong, or revoked. Check the key and the `Authorization` header. |
| **402** | You’ve hit your plan’s usage limit. Upgrade your plan or try again later. |
| **429** | Too many requests. Wait and retry; back off if it happens again. |
| **5xx** | Server error. Retry once or twice; if it continues, contact support with `x-request-id`. |

---

## SDK

The TypeScript SDK exposes the same operations: `addMemory`, `addConversationMemory`, `ingest`, `search`, `context`, `contextExplain`, `listMemories`, `getMemory`, `deleteMemory`, `importMemories`, `getUsageToday`. Use your API key when you create the client. It supports `memory_type` and `extract` on add; `search_mode`, `min_score`, and filter `memory_type` / `filter_mode` on search and context; `memoryType` query param on list.

Recommended default flow in app code: `search` -> `context` -> `contextExplain` so developers can verify retrieval reasoning early.

See [packages/sdk/README.md](../../packages/sdk/README.md).
