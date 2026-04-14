# MemoryNode Console

Minimal console MVP with Supabase Auth (Google + GitHub OAuth + magic link) and RLS-safe views for workspaces, API keys, team management, and billing.

**Production Google login:** operators must enable the Google provider and redirect allowlist in Supabase — see [`docs/internal/SUPABASE_GOOGLE_OAUTH_SETUP.md`](../../docs/internal/SUPABASE_GOOGLE_OAUTH_SETUP.md).
Worker API billing controls are wired to PayU checkout using your normal API key (stored locally).

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
```

Use the **anon** (not service-role) key so browser traffic is RLS-enforced.

## Workspace scoping / RLS

- RLS enforces membership via `workspace_members`; claims alone are not sufficient.
- Set `workspace_id` from the UI for convenience, but access still requires membership.
- Creating a workspace calls the `create_workspace` RPC, which inserts the workspace and adds you as `owner`.

## Usage tab

- Set your Worker API key once in the **API key** panel (top of the dashboard). It’s stored locally only.
- Data is fetched from Worker API `/v1/usage/today`; shows counts and plan limits with friendly errors (401 invalid key, 402 over cap, 429 rate limited).

## Import tab (paid)

- Import supports artifact-based bulk ingest through Worker API `POST /v1/import`.
- Free plans receive `402 UPGRADE_REQUIRED`; paid plans can run import modes (`upsert`, `skip_existing`, `error_on_conflict`, `replace_ids`, `replace_all`).

## Billing

- Uses Worker API endpoints:
  - `GET /v1/billing/status` (shows plan, plan_status, effective_plan, renewal/cancel flags)
  - `POST /v1/billing/checkout` (opens PayU checkout)
  - `POST /v1/billing/portal` (returns `410 Gone`; legacy Stripe portal removed)
- Buttons:
  - **Upgrade to Pro (PayU)** → opens checkout in a new tab.
- Query params `?status=success|canceled` render a small banner after returning from checkout.

## Production build (local or CI)

`vite build` requires a **non-localhost** `VITE_API_BASE_URL` in production mode.

- **CI:** set `VITE_API_BASE_URL` in the workflow or host (see root `.github/workflows/ci.yml`).
- **Local:** copy [`.env.production.example`](./.env.production.example) to **`.env.production`** in this folder (gitignored), set your real API origin, then run `pnpm build` from `apps/dashboard` or `pnpm --filter @memorynode/dashboard build` from the repo root.

## Commands

- `pnpm dev --filter @memorynode/dashboard`
- `pnpm build --filter @memorynode/dashboard`
- `pnpm preview --filter @memorynode/dashboard`
