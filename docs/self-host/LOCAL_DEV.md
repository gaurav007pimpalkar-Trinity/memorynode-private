# Local development (minimal)

**Not required** for integrating with the hosted API. Use this when you work inside this repository.

## Prerequisites

- Node.js **20+**
- **pnpm** 10+
- A **Supabase** (or Postgres) project and `DATABASE_URL` / `SUPABASE_DB_URL` if you run migrations

## Quick path (stub embeddings)

1. `pnpm install`
2. Copy secrets template: `cp apps/api/.dev.vars.template apps/api/.dev.vars` and fill values (see [apps/api/.env.local.example](../../apps/api/.env.local.example) for the short checklist).
3. Prefer **`EMBEDDINGS_MODE=stub`** and **`SUPABASE_MODE=dev`** for local iteration without real OpenAI spend.
4. Apply SQL: `pnpm db:migrate` (requires DB URL).
5. Run API: `pnpm dev` from repo root, or `pnpm dev:stub` for a guided check + `wrangler dev`.

API default local URL: `http://127.0.0.1:8787`

## Bootstrap project + API key (optional)

When `MASTER_ADMIN_TOKEN` is set and the API is running:

```bash
MASTER_ADMIN_TOKEN=your_token node scripts/dev_bootstrap.mjs
```

## CI: migration manifest

The migration list is checked in CI. Keep the line below updated when you add migrations under `infra/sql/`:

<!-- Migration manifest (CI-checked): MIGRATIONS_TOTAL=60; MIGRATIONS_LATEST=058_memory_owner_fields.sql -->

## Where to read next

- Operator / release docs: [../internal/README.md](../internal/README.md)
- Production checklist: [../PROD_SETUP_CHECKLIST.md](../PROD_SETUP_CHECKLIST.md)
