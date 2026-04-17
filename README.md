# MemoryNode.ai

**Reliable per-user memory for customer-facing AI** — support bots, SMB chat agents, and SaaS copilots that must remember the customer across sessions. Store facts with one API; retrieve the right context with hybrid search — **no vector DB or search stack to run yourself.**

Canonical positioning: **[docs/external/POSITIONING.md](docs/external/POSITIONING.md)**.

## Who it is for

- **Support and success** — ticket continuity, fewer repeated questions.
- **High-volume chat** (web, WhatsApp-style backends) — cap-aware, simple integration.
- **B2B SaaS copilots** — scoped `user_id` + `namespace` per tenant.

**Not the focus:** universal “sync every SaaS tool” knowledge platforms — see non-goals in [POSITIONING.md](docs/external/POSITIONING.md).

## Quick outcome (~15 minutes)

1. **Sign up** — [console.memorynode.ai](https://console.memorynode.ai): workspace + API key.
2. **Insert** — `POST /v1/memories` with `user_id`, `text`, optional `namespace`.
3. **Search or context** — `POST /v1/search` or `POST /v1/context` with the same `user_id` / `namespace`.

Full steps: **[Quickstart](docs/external/QUICKSTART.md)** · **Recipes:** [support](docs/external/RECIPE_SUPPORT_AGENT.md) · [SaaS copilot](docs/external/RECIPE_SAAS_COPILOT.md) · [SMB chat](docs/external/RECIPE_SMB_CHATBOT.md) · **Runnable:** [examples/support-bot-minimal](examples/support-bot-minimal/README.md)

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

Or run: `API_KEY=mn_live_xxx node examples/basic-usage.js`

## MCP example

Use the MemoryNode MCP server so AI tools can read/write memory without custom code:

```bash
pnpm add @memorynodeai/mcp-server
# Configure MCP with MEMORYNODE_API_KEY, MEMORYNODE_BASE_URL, optional MEMORYNODE_NAMESPACE; then use memory_search, memory_context, and memory_insert tools.
```

See **[MCP server](packages/mcp-server/README.md)** and **[QUICKSTART – Connect MCP](docs/external/QUICKSTART.md#4-connect-mcp)**. **When to use REST vs MCP:** [docs/MCP_SERVER.md](docs/MCP_SERVER.md).

## Trust

- **[Trust (customer-facing)](docs/external/TRUST.md)** · **[Data retention](docs/DATA_RETENTION.md)** · **[Security](docs/SECURITY.md)**

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
| `docs/external/` | Developer docs (Quickstart, recipes, API usage) |

## Develop

```bash
pnpm install
cp .env.example .env   # and apps/api/.dev.vars.template → apps/api/.dev.vars
pnpm db:migrate        # needs DATABASE_URL or SUPABASE_DB_URL
pnpm dev               # API at http://127.0.0.1:8787
```

See [Quickstart](docs/external/QUICKSTART.md) for first API calls and [internal docs](docs/internal/README.md) for CI, deploy, and runbooks.
