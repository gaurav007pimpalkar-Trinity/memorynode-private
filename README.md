# MemoryNode.ai

**Drop-in memory for your app** — your AI remembers each customer across sessions. Store text with one API; get **hybrid search** and **prompt-ready context** without running pgvector yourself.

**Start in ~10 minutes (hosted only):** [docs/start-here/README.md](docs/start-here/README.md) · **Positioning:** [docs/external/POSITIONING.md](docs/external/POSITIONING.md)

## Who it is for

- **Support and success** — ticket continuity, fewer repeated questions.
- **High-volume chat** — cap-aware, simple integration.
- **B2B SaaS copilots** — scoped `user_id` + `namespace` per tenant.

## Hosted API (default path)

```bash
export API_KEY=mn_live_xxx
curl -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"user-1","text":"User prefers dark mode"}'
curl -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"user-1","query":"theme preference","top_k":5}'
```

- **More examples:** [docs/start-here/README.md](docs/start-here/README.md)
- **Advanced (filters, SDK, OpenAPI):** [docs/build/README.md](docs/build/README.md)
- **Python example:** [examples/python-quickstart/README.md](examples/python-quickstart/README.md)
- **Node example:** [examples/node-quickstart/README.md](examples/node-quickstart/README.md)

## MCP (AI tools / editors)

```bash
pnpm add @memorynodeai/mcp-server
```

See [packages/mcp-server/README.md](packages/mcp-server/README.md) and [docs/MCP_SERVER.md](docs/MCP_SERVER.md).

## Trust

- [Trust (customer-facing)](docs/external/TRUST.md) · [Data retention](docs/DATA_RETENTION.md) · [Security](docs/SECURITY.md)

## Architecture (one line)

Hosted **Cloudflare Worker** API + **Supabase** (Postgres + pgvector) + optional **dashboard** + **TypeScript SDK** + **MCP**.

## Monorepo layout

| Path | Description |
|------|-------------|
| `apps/api` | Cloudflare Worker API |
| `apps/dashboard` | Web dashboard |
| `packages/sdk` | TypeScript SDK |
| `packages/mcp-server` | MCP server |
| `packages/shared` | Shared types and plans |
| `docs/start-here` | Default developer path (hosted) |
| `docs/build` | Advanced API usage |
| `docs/self-host` | Run the repo / local dev |

## Run the API locally (advanced)

Not required for product integration. See **[docs/self-host/LOCAL_DEV.md](docs/self-host/LOCAL_DEV.md)** and `pnpm dev:stub` after copying `apps/api/.dev.vars.template` → `apps/api/.dev.vars`.

Internal CI / runbooks: [docs/internal/README.md](docs/internal/README.md).
