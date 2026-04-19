# API usage

How to call the MemoryNode API and what to expect. Base URL: `https://api.memorynode.ai` (or your deployment’s URL).

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
| user_id | Yes | Your end-user’s identifier. Use the same when you search. |
| text | Yes | The memory content. |
| namespace | No | Scope (e.g. app or environment). Use the same when you search. |
| metadata | No | Optional key-value pairs. |
| memory_type | No | Optional tag: `fact`, `preference`, `event`, `note`, or `task`. |
| extract | No | Defaults to **`true`**. When allowed by plan/budget, runs lightweight LLM extraction to child memories. Set **`false`** to store only the parent memory. |

Example: `{"user_id":"user-123","namespace":"myapp","text":"User loves coffee"}`

With typing and extraction: `{"user_id":"user-123","text":"I'm vegetarian and visited Paris last week","memory_type":"note","extract":true}`

Response: always includes **`"stored": true`** on HTTP 200 (your row was saved). **`chunks`** is the count of search-indexed segments when embedding ran; it may be omitted when embedding was skipped (e.g. text-only ingest under global AI budget — then **`"embedding": "skipped_due_to_budget"`** appears instead). **`extraction`**: `{ "status": "run" | "degraded" | "skipped" }`; when `status` is `skipped`, a **`reason`** (and optional **`error`**) is included. Headers: **`x-extraction-status`** always; **`x-extraction-reason`** only when skipped (and not `none`).

---

## List and delete memories

- **GET /v1/memories** — List memories. Query params: `page`, `page_size`, `user_id`, `namespace`, `memory_type` (fact | preference | event | note | task), and optional filters (`metadata`, `start_time`, `end_time`).
- **GET /v1/memories/:id** — Fetch one memory.
- **DELETE /v1/memories/:id** — Delete a memory.

---

## Search

**POST /v1/search**

Body: `user_id`, `query`, and optional `namespace`, `top_k`, `page`, `page_size`, `explain`. Use the same `user_id` and `namespace` as when you stored.

Optional fields:

| Field | Description |
|-------|-------------|
| search_mode | `hybrid` (default), `vector`, or `keyword`. `keyword` avoids embedding usage. |
| min_score | Minimum relevance score 0–1; results below are dropped. |
| filters.memory_type | Single value or array: `fact`, `preference`, `event`, `note`, `task` (OR semantics). |
| filters.filter_mode | For metadata: `and` (default) or `or`. |

Response: List of matching memories (and optional scores). You can send `"explain": true` to get a short explanation of why each result matched.

---

## Context (for prompts)

**POST /v1/context**

Same body as search (including optional `search_mode`, `min_score`, and `filters.memory_type` / `filters.filter_mode`). Response includes `context_text` (formatted text of relevant memories), `citations`, and optionally `context_blocks` (count after merging adjacent chunks). Use this to build your AI prompt.

---

## Context explain (debug retrieval)

**GET /v1/context/explain**

Query params: `user_id`, `query`, and optional `namespace`, `top_k`, `page`, `page_size`, `search_mode`, `min_score`, `retrieval_profile`.

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

The TypeScript SDK exposes the same operations: `addMemory`, `search`, `context`, `contextExplain`, `listMemories`, `getMemory`, `deleteMemory`, `importMemories`, `getUsageToday`. Use your API key when you create the client. It supports `memory_type` and `extract` on add; `search_mode`, `min_score`, and filter `memory_type` / `filter_mode` on search and context; `memoryType` query param on list.

Recommended default flow in app code: `search` -> `context` -> `contextExplain` so developers can verify retrieval reasoning early.

See [packages/sdk/README.md](../../packages/sdk/README.md).
