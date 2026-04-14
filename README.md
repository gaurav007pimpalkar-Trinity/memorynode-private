# MemoryNode.ai

**Memory layer for AI applications.** Store user facts and conversation; retrieve the right context for your chatbot or assistant with one API. No vector DB or search stack to run yourself.

## Quickstart (5 minutes)

1. **Get an API key** — [Sign up](https://memorynode.ai), create a workspace, create an API key.
2. **Insert a memory** — `POST /v1/memories` with `user_id`, `text`, optional `namespace`.
3. **Search** — `POST /v1/search` with same `user_id`/`namespace` and a `query`; use results or `POST /v1/context` for prompt-ready text.

Full steps: **[Quickstart](docs/external/QUICKSTART.md)**.

## API example

```bash
export API_KEY=mn_live_xxx
curl -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"user-1","text":"User prefers dark mode"}'
curl -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"user-1","query":"theme preference","top_k":5}'
```

Or run the example script: `API_KEY=mn_live_xxx node examples/basic-usage.js`

## MCP example

Use the MemoryNode MCP server so AI tools can read/write memory without custom code:

```bash
pnpm add @memorynodeai/mcp-server
# Configure MCP with MEMORYNODE_API_KEY, MEMORYNODE_BASE_URL, optional MEMORYNODE_NAMESPACE; then use memory_search, memory_context, and memory_insert tools.
```

See **[MCP server](packages/mcp-server/README.md)** and **[QUICKSTART – Connect MCP](docs/external/QUICKSTART.md#4-connect-mcp)**.

## Architecture (overview)

- **API** — Cloudflare Worker (`apps/api`): REST over HTTPS; auth via API key; rate limit per key; memories and chunks in Supabase (Postgres + pgvector).
- **Search** — Hybrid (vector + keyword); optional recency decay; scoped by `user_id` and `namespace`.
- **Dashboard** — React app for workspaces, API keys, usage, billing.
  - Import in console/API is available on paid plans (`POST /v1/import`).
- **SDK** — TypeScript client (`packages/sdk`); optional MCP server (`packages/mcp-server`) for agent tooling.

## Repo layout

| Path | Description |
|------|-------------|
| `apps/api` | Cloudflare Worker API |
| `apps/dashboard` | Web dashboard |
| `packages/sdk` | TypeScript SDK |
| `packages/mcp-server` | MCP server for AI tools |
| `packages/shared` | Shared types and plans |
| `docs/external/` | Developer docs (Quickstart, API usage) |

## Develop

```bash
pnpm install
cp .env.example .env   # and apps/api/.dev.vars.template → apps/api/.dev.vars
pnpm db:migrate        # needs DATABASE_URL or SUPABASE_DB_URL
pnpm dev               # API at http://127.0.0.1:8787
```

See [Quickstart](docs/external/QUICKSTART.md) for first API calls and [internal docs](docs/internal/README.md) for CI, deploy, and runbooks.
