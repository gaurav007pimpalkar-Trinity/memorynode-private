# Quickstart

Get from zero to storing and retrieving memories in a few minutes.

## 1. Get an API key

Sign up and create a workspace in the dashboard. Create an API key and copy it once — it’s shown only at creation. Use it as: `Authorization: Bearer <your_api_key>`.

## 2. Store a memory

Send a POST request to `/v1/memories` with your API key and a JSON body:

- **user_id** — Your end-user’s id (e.g. from your app).
- **text** — The memory content.
- **namespace** (optional) — e.g. a project or environment name. Use the same value when you search.

Example (replace `YOUR_API_KEY` and `https://api.memorynode.ai` with your key and base URL):

```bash
curl -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-123","namespace":"myapp","text":"User prefers dark mode"}'
```

You’ll get back a `memory_id` and related details.

## 3. Search or get context

Use the same **user_id** and **namespace** you used when storing.

**Search** — POST to `/v1/search` with `user_id`, `query`, and optional `namespace`:

```bash
curl -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-123","namespace":"myapp","query":"theme preference","top_k":5}'
```

**Context** (for prompts) — POST to `/v1/context` with the same fields. The response includes `context_text` and `citations` ready to use in your AI prompt. You can optionally tag memories with `memory_type` (fact, preference, event, note), use `search_mode` (hybrid, vector, keyword), and filter by `memory_type` in search/context — see [API usage](./API_USAGE.md).

## 4. If something goes wrong

- **401** — Check your API key and that you’re sending `Authorization: Bearer <key>`.
- **Empty results** — Use the same `user_id` and `namespace` as when you stored; confirm you stored at least one memory first.
- **Other errors** — Retry once or twice; if it continues, contact support with the `x-request-id` from the response.

For full request and response shapes, see [API usage](./API_USAGE.md).

<!-- Migration manifest (CI-checked): MIGRATIONS_TOTAL=31; MIGRATIONS_LATEST=029_memory_recency_decay.sql -->
