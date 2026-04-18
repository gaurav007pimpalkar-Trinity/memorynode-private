# Start here (about 10 minutes)

MemoryNode is a **hosted API** that remembers your users across sessions: **save** text, **search** it, or drop **prompt-ready context** into your LLM. You do **not** need this repo, migrations, or Wrangler to ship.

## 1. Get an API key

1. Sign up at [memorynode.ai](https://memorynode.ai) (or your operator’s console).
2. Create a workspace and an API key. Copy it once (looks like `mn_live_...`).

**Base URL:** `https://api.memorynode.ai` (or the URL you were given).

**Auth:** every request needs your key:

- `Authorization: Bearer <YOUR_API_KEY>` **or**
- `x-api-key: <YOUR_API_KEY>`

## 2. Save a memory

`POST /v1/memories`

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-123","namespace":"myapp","text":"User prefers dark mode"}'
```

Use the same `user_id` (and `namespace` if you set one) when you search.

## 3. Search

`POST /v1/search`

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-123","namespace":"myapp","query":"theme preference","top_k":5}'
```

## 4. Prompt-ready context (optional but typical)

`POST /v1/context` — same JSON idea as search; response includes `context_text` and `citations` for your prompt.

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/context" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-123","namespace":"myapp","query":"What do we know about theme preferences?"}'
```

## Smart defaults (no config)

- **Hybrid search** is the default on the API.
- **Extraction** is on by default where your **plan and budget** allow; the API **never fails the write** because of extraction. To store only the parent memory, send `"extract": false`.

## Next steps

- **Non-technical / founder-only path:** [FOUNDER_PATH.md](./FOUNDER_PATH.md)
- **More control (filters, modes, SDK, OpenAPI):** [../build/README.md](../build/README.md)
- **Run the API yourself (advanced):** [../self-host/LOCAL_DEV.md](../self-host/LOCAL_DEV.md)

Canonical product story: [../external/POSITIONING.md](../external/POSITIONING.md).
