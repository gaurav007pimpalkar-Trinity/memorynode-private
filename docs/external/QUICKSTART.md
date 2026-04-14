# Quickstart

Get from zero to stored and retrieved memory in a few minutes. No marketing fluff.

## 1. Setup

- Sign up at [memorynode.ai](https://memorynode.ai), create a workspace, create an API key. Copy the key once (e.g. `mn_live_...`).
- Base URL: `https://api.memorynode.ai` (or your deployment).
- Send the key on every request: `Authorization: Bearer <key>` or header `x-api-key: <key>`.

## 2. Insert

**POST /v1/memories**

```bash
curl -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-123","namespace":"myapp","text":"User prefers dark mode"}'
```

Response: `{"memory_id":"...", "chunks": 1}`. Use the same `user_id` and `namespace` when you search.

## 3. Search

**POST /v1/search**

```bash
curl -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-123","namespace":"myapp","query":"theme preference","top_k":5}'
```

Response: `{"results": [{"chunk_id":"...", "memory_id":"...", "text":"...", "score": 0.9}, ...]}`.

For prompt-ready text and citations, use **POST /v1/context** with the same body; response includes `context_text` and `citations`.

## 4. Connect MCP

To let AI agents read/write memory via MCP tools:

1. Install: `pnpm add @memorynodeai/mcp-server` (or use the repo package).
2. Configure your MCP client with:
   - `MEMORYNODE_API_KEY` — your API key.
   - `MEMORYNODE_BASE_URL` — `https://api.memorynode.ai` (or your base URL).
3. Use the `memory://search` resource and the memory insert tool from your agent.

See [packages/mcp-server](packages/mcp-server) and [API usage](API_USAGE.md) for full request/response shapes.

<!-- Migration manifest (CI-checked): MIGRATIONS_TOTAL=33; MIGRATIONS_LATEST=031_workspace_members_rls_recursion_fix.sql -->
