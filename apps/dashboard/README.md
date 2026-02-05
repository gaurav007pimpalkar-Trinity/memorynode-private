# MemoryNode Dashboard

Minimal MVP with Supabase Auth (GitHub OAuth + magic link) and RLS-safe views for workspaces, API keys, memories, and usage.
Worker API billing controls are wired to Stripe Checkout/Portal using your normal API key (stored locally).

## Run locally
```bash
cp apps/dashboard/.env.example apps/dashboard/.env.local   # fill in URL + anon key
corepack pnpm install
corepack pnpm dev --filter @memorynode/dashboard
```
Default dev server: http://localhost:4173

## Env vars
Create `.env.local` (or `.env`) in `apps/dashboard/`:
```
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

## Activation tab
- Shows activation funnel events per workspace (api_key_created, first_ingest/search/context_success, cap_exceeded, checkout_started, upgrade_activated).
- Toggle between last 24h and last 7d; data comes from Supabase RPC `activation_counts` (RLS enforced via membership).
- Screenshot: simple list with event names and counts; a workspace selector prompt appears if none is chosen.

## Billing
- Uses Worker API endpoints:
  - `GET /v1/billing/status` (shows plan, plan_status, effective_plan, renewal/cancel flags)
  - `POST /v1/billing/checkout` (opens Stripe Checkout)
  - `POST /v1/billing/portal` (opens Stripe Billing Portal)
- Buttons:
  - **Upgrade to Pro** → opens Checkout session in a new tab.
  - **Manage billing** → opens Portal (409 “Upgrade first” if no customer yet).
- Query params `?status=success|canceled` render a small banner after returning from Stripe.

## Commands
- `pnpm dev --filter @memorynode/dashboard`
- `pnpm build --filter @memorynode/dashboard`
- `pnpm preview --filter @memorynode/dashboard`
