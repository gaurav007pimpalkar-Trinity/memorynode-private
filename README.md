# MemoryNode.ai

**Memory layer for AI applications** — store user facts and conversations, then retrieve the right context for your chatbot, copilot, or assistant.

## Quick links

| I want to… | Doc |
|------------|-----|
| What MemoryNode is and who it’s for | [docs/external/README](docs/external/README.md) |
| Get value quickly | [Quickstart](docs/external/QUICKSTART.md) |
| How to call the API and SDK | [API usage](docs/external/API_USAGE.md) |

## Repo layout

- **`apps/api`** — Cloudflare Worker API (memories, search, context, billing).
- **`apps/dashboard`** — Web app for workspaces, API keys, and usage.
- **`packages/shared`** — Shared types and plans.
- **`packages/sdk`** — TypeScript SDK.
- **`docs/`** — Documentation ([internal](docs/internal/README.md) vs [external](docs/external/)).

## Develop

```bash
pnpm install
cp .env.example .env   # and apps/api/.dev.vars.template → apps/api/.dev.vars (fill values)
pnpm db:migrate        # requires DATABASE_URL or SUPABASE_DB_URL
pnpm dev               # API at http://127.0.0.1:8787
pnpm --filter @memorynode/dashboard dev   # Dashboard at http://localhost:5173
```

See [Quickstart](docs/external/QUICKSTART.md) for first API calls.
