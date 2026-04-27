# Dashboard Pages Deploy

MemoryNode ships two Cloudflare Pages projects from the single React app at [apps/dashboard](../../apps/dashboard/). Both are built from the same commit and deployed via `wrangler pages deploy` (direct upload). The Cloudflare "Connect to Git" integration is intentionally **disconnected** on both projects; deploys only happen through GitHub Actions.

Upload paths:

- **Production (default):** [.github/workflows/release_production.yml](../../.github/workflows/release_production.yml) — after approval, deploys the **SHA from the staging `approved-release` artifact** (API + both Pages + smoke). No manual SHA. Re-run the workflow to promote the **latest** staging-approved build, or use Cloudflare Pages rollback (§5).
- **Staging:** [.github/workflows/release_staging.yml](../../.github/workflows/release_staging.yml) — after green CI on `main`, deploys API staging then dashboard to **separate** Pages project names (secrets `DASHBOARD_PAGES_PROJECT_*` on the `staging` environment; must not be `memorynode-console` / `memorynode-app` when using a non-production API).

Optional env overrides for project names (defaults: production names): see [scripts/deploy_dashboard_pages.mjs](../../scripts/deploy_dashboard_pages.mjs) (`DASHBOARD_PAGES_PROJECT_CONSOLE`, `DASHBOARD_PAGES_PROJECT_APP`).

## 1. Surfaces

| Surface | Pages project | Production hostname | `VITE_APP_SURFACE` |
| --- | --- | --- | --- |
| Console (billing / admin) | `memorynode-console` | `console.memorynode.ai` | `console` |
| App (end-user) | `memorynode-app` | `app.memorynode.ai` | `app` |

The same Vite bundle output is tailored per surface through `VITE_APP_SURFACE` and `VITE_APP_HOSTNAME`. See [apps/dashboard/vite.config.ts](../../apps/dashboard/vite.config.ts) and `pnpm dashboard:deploy:pages`.

## 2. Build env

Set as GitHub Actions secrets on the `production` environment:

| Secret → Env var | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Pages deploy authorization (Pages:Edit) |
| `CLOUDFLARE_ACCOUNT_ID` | Pages deploy target |
| `DASHBOARD_VITE_SUPABASE_URL` → `VITE_SUPABASE_URL` | Supabase project URL |
| `DASHBOARD_VITE_SUPABASE_ANON_KEY` → `VITE_SUPABASE_ANON_KEY` | Supabase anon key for browser auth |

Baked from the workflow file:

- `VITE_API_BASE_URL=https://api.memorynode.ai`
- `VITE_CONSOLE_BASE_URL=https://console.memorynode.ai`
- `VITE_BUILD_SHA=<HEAD sha>` (injected from `git rev-parse HEAD`)

## 3. Deploy flow

### 3.1 Production release (coupled to API)

1. **Release Production** starts when staging succeeds, or run it manually to pick up the **latest** successful staging artifact.
2. After environment approval on the `promote` job: checkout approved SHA → validate secrets → `pnpm release:gate` (includes live `/healthz` + `/ready` when `RELEASE_GATE_LIVE=1`) → `pnpm deploy:prod` → `pnpm dashboard:deploy:pages` → `pnpm smoke:prod`.
3. Build failures abort before any upload; if deploy fails mid-way, fix forward with a new commit through staging, or use Cloudflare rollback (§5).

### 3.2 Supabase key rotation (dashboard rebuild only)

If only Supabase browser keys changed and the Worker is unchanged, re-run **Release Production** (workflow_dispatch) so the **latest staging-approved SHA** is redeployed with updated dashboard secrets. Alternatively promote a prior Pages deployment in Cloudflare (§5) until the next full release.

## 4. Post-deploy checks

- `https://console.memorynode.ai` and `https://app.memorynode.ai` return 200 with the expected surface.
- Browser dev tools: network requests hit `https://api.memorynode.ai`.
- Sign-in via Supabase Google OAuth succeeds; after redirect, `POST /v1/dashboard/session` sets `mn_session` cookie + returns a CSRF token.
- `GET /v1/dashboard/overview-stats` returns data.

## 5. Rollback

Use the Cloudflare Pages UI: select the affected project (`memorynode-console` or `memorynode-app`), open *Deployments*, and promote the previous successful deployment. Past deployments stay uploaded even though the Git integration is disconnected.

If the cause is a bad commit, merge a fix through staging again, or promote a prior Pages deployment in Cloudflare until the Worker can roll forward. For the Worker alone, use **Rollback Production** or `wrangler rollback --env production`.

## 6. Adding or rotating Supabase keys

1. Update the Supabase project keys.
2. In GitHub repo settings → Environments → `production`, update `DASHBOARD_VITE_SUPABASE_URL` / `DASHBOARD_VITE_SUPABASE_ANON_KEY`.
3. Re-run **Release Production** (workflow_dispatch) after updating `DASHBOARD_VITE_*` in GitHub so the latest staging-approved SHA is rebuilt. The Worker's Supabase secrets (see [PROD_SETUP_CHECKLIST.md](../PROD_SETUP_CHECKLIST.md)) are independent and rotated with `wrangler secret put`.

## 7. Related

- Session cookie + CSRF: [DASHBOARD_SESSION_SETUP.md](./DASHBOARD_SESSION_SETUP.md).
- Supabase OAuth handoff: [SUPABASE_GOOGLE_OAUTH_SETUP.md](./SUPABASE_GOOGLE_OAUTH_SETUP.md).
- Worker deploy (API): [RELEASE_RUNBOOK.md](./RELEASE_RUNBOOK.md).
