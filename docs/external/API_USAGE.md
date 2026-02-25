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

Example: `{"user_id":"user-123","namespace":"myapp","text":"User loves coffee"}`

Response: `{"memory_id":"...", "chunks": ...}`

---

## List and delete memories

- **GET /v1/memories** — List memories. Query params: `page`, `page_size`, `user_id`, `namespace`, and optional filters.
- **GET /v1/memories/:id** — Fetch one memory.
- **DELETE /v1/memories/:id** — Delete a memory.

---

## Search

**POST /v1/search**

Body: `user_id`, `query`, and optional `namespace`, `top_k`, `page`, `page_size`. Use the same `user_id` and `namespace` as when you stored.

Response: List of matching memories (and optional scores). You can send `"explain": true` to get a short explanation of why each result matched.

---

## Context (for prompts)

**POST /v1/context**

Same body as search. Response includes `context_text` (formatted text of relevant memories) and `citations` (chunk and memory ids). Use this to build your AI prompt.

---

## Usage today

**GET /v1/usage/today**

Returns how much you’ve used today and your plan’s limits. Use it to show usage in your app or to avoid hitting limits.

---

## Billing

- **GET /v1/billing/status** — Current plan and period. Use `effective_plan` from the response for display and limits.
- **POST /v1/billing/checkout** — Start an upgrade. Body: `{"plan": "launch" | "build" | "deploy" | "scale" | "scale_plus"}`. You get a link or form to complete payment.

---

## Export and import

- **POST /v1/export** — Get a copy of your memories (artifact or ZIP).
- **POST /v1/import** — Restore from an export. Body: `{"artifact_base64": "...", "mode": "upsert" | "skip_existing" | ...}`.

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

The TypeScript SDK exposes the same operations: `addMemory`, `search`, `context`, `listMemories`, `getMemory`, `deleteMemory`, `exportMemories`, `importMemories`, `getUsageToday`. Use your API key when you create the client.
