# MemoryNode Frontends

Product positioning (ICP and non-goals): [docs/external/POSITIONING.md](../../docs/external/POSITIONING.md).

Shared frontend codebase for:
- `console.memorynode.ai` -> customer console
- `app.memorynode.ai/founder` -> founder dashboard

The console uses Supabase Auth (Google + GitHub OAuth + magic link) and project-scoped dashboard sessions (internal key remains `workspace_id`). The founder app uses admin-token access only.

## Run locally

```bash
cp apps/dashboard/.env.example apps/dashboard/.env.local   # fill in URL + anon key
corepack pnpm install
corepack pnpm dev --filter @memorynode/dashboard
```

Default dev server: [http://localhost:4173](http://localhost:4173).

## Env vars

Create `.env.local` (or `.env`) in `apps/dashboard/`:

```bash
VITE_SUPABASE_URL=<your-supabase-url>
VITE_SUPABASE_ANON_KEY=<your-anon-public-key>
VITE_API_BASE_URL=http://127.0.0.1:8787
VITE_APP_SURFACE=console
VITE_CONSOLE_BASE_URL=https://console.memorynode.ai
```

Use the **anon** (not service-role) key so browser traffic is RLS-enforced. Founder-only deployments can omit the Supabase vars if they do not render the customer console surface.

## Surfaces

- `VITE_APP_SURFACE=console` renders the customer console for `console.memorynode.ai`
- `VITE_APP_SURFACE=app` renders the founder app and owns `/founder` on `app.memorynode.ai`
- `VITE_CONSOLE_BASE_URL` controls the “Open customer console” link from the founder app

## Project scoping / RLS

- RLS enforces membership via `workspace_members`; claims alone are not sufficient.
- Set `workspace_id` from the UI for convenience, but access still requires membership.
- Creating a project calls the `create_workspace` RPC, which inserts the internal workspace row and adds you as `owner`.

## Usage tab

- Usage is project-scoped and loaded through dashboard session auth.
- Data is fetched from Worker API `/v1/usage/today`; shows reads/writes/embed consumption and plan limits with friendly errors.

## Import tab (paid)

- Import supports artifact-based bulk ingest through Worker API `POST /v1/import`.
- Free plans receive `402 UPGRADE_REQUIRED`; paid plans can run import modes (`upsert`, `skip_existing`, `error_on_conflict`, `replace_ids`, `replace_all`).

## Billing

- Uses Worker API endpoints:
  - `GET /v1/billing/status` (shows plan, plan_status, effective_plan, renewal/cancel flags)
  - `POST /v1/billing/checkout` (opens PayU checkout)
- Buttons:
  - **Upgrade to Pro (PayU)** → opens checkout in a new tab.
- Query params `?status=success|canceled` render a small banner after returning from checkout.

## Production build (local or CI)

`vite build` requires a **non-localhost** `VITE_API_BASE_URL` in production mode.

- **CI:** set `VITE_API_BASE_URL` in the workflow or host (see root `.github/workflows/ci.yml`).
- **Local:** copy [`.env.production.example`](./.env.production.example), [`.env.console.production.example`](./.env.console.production.example), or [`.env.app.production.example`](./.env.app.production.example) to **`.env.production`** in this folder (gitignored), set your real origins, then run `pnpm build` from `apps/dashboard` or `pnpm --filter @memorynode/dashboard build` from the repo root.

## Commands

- `pnpm dev --filter @memorynode/dashboard`
- `pnpm build --filter @memorynode/dashboard`
- `pnpm preview --filter @memorynode/dashboard`
