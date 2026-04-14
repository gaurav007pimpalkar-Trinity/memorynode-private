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
| memory_type | No | Optional tag: `fact`, `preference`, `event`, or `note`. |
| extract | No | If `true`, runs lightweight LLM extraction to create child memories (facts/preferences/events). |

Example: `{"user_id":"user-123","namespace":"myapp","text":"User loves coffee"}`

With typing and extraction: `{"user_id":"user-123","text":"I'm vegetarian and visited Paris last week","memory_type":"note","extract":true}`

Response: `{"memory_id":"...", "chunks": ...}`. When `extract` was used, response also includes `extraction: { triggered, children_created, skipped, error? }`.

---

## List and delete memories

- **GET /v1/memories** — List memories. Query params: `page`, `page_size`, `user_id`, `namespace`, `memory_type` (fact | preference | event | note), and optional filters (`metadata`, `start_time`, `end_time`).
- **GET /v1/memories/:id** — Fetch one memory.
- **DELETE /v1/memories/:id** — Delete a memory.

---

## Search

**POST /v1/search**

Body: `user_id`, `query`, and optional `namespace`, `top_k`, `page`, `page_size`, `explain`. Use the same `user_id` and `namespace` as when you stored.

Optional Phase 6 fields:

| Field | Description |
|-------|-------------|
| search_mode | `hybrid` (default), `vector`, or `keyword`. `keyword` avoids embedding usage. |
| min_score | Minimum relevance score 0–1; results below are dropped. |
| filters.memory_type | Single value or array: `fact`, `preference`, `event`, `note` (OR semantics). |
| filters.filter_mode | For metadata: `and` (default) or `or`. |

Response: List of matching memories (and optional scores). You can send `"explain": true` to get a short explanation of why each result matched.

---

## Context (for prompts)

**POST /v1/context**

Same body as search (including optional `search_mode`, `min_score`, and `filters.memory_type` / `filters.filter_mode`). Response includes `context_text` (formatted text of relevant memories), `citations`, and optionally `context_blocks` (count after merging adjacent chunks). Use this to build your AI prompt.

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

The TypeScript SDK exposes the same operations: `addMemory`, `search`, `context`, `listMemories`, `getMemory`, `deleteMemory`, `importMemories`, `getUsageToday`. Use your API key when you create the client. It supports Phase 6 options: `memory_type` and `extract` on add; `search_mode`, `min_score`, and filter `memory_type` / `filter_mode` on search and context; `memoryType` query param on list.
