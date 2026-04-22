# Dashboard Pages Deploy

MemoryNode ships two Cloudflare Pages projects from the single React app at [apps/dashboard](../../apps/dashboard/). Both are built from the same commit and deployed via `wrangler pages deploy` (direct upload). The Cloudflare "Connect to Git" integration is intentionally **disconnected** on both projects; deploys only happen through GitHub Actions.

Two workflows can upload to these projects:

- **Production release (default)**: [.github/workflows/api-deploy.yml](../../.github/workflows/api-deploy.yml) runs `deploy-production` (Worker) and, on success, `deploy-dashboards-production` (console + app) in the same workflow run. One `workflow_dispatch` with `environment=production` ships Worker + both Pages projects.
- **Dashboard-only hotfix**: [.github/workflows/dashboard-pages-deploy.yml](../../.github/workflows/dashboard-pages-deploy.yml) — `workflow_dispatch` only. Use when a dashboard change must ship without touching the Worker.

Staging API auto-deploys on every push to `main`, but dashboards are **not** coupled to staging; there are no staging Pages projects.

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

1. Trigger `API Deploy` workflow with `environment=production` and a `ref`.
2. `deploy-production` job deploys the Worker (`pnpm deploy:prod`).
3. On success, `deploy-dashboards-production` runs with `needs: [deploy-production]`:
   1. Checkout at the same `ref`.
   2. `pnpm install --frozen-lockfile`.
   3. `Validate dashboard deploy secrets` — fails loudly if any of the four secrets above is unset.
   4. `pnpm dashboard:deploy:pages` — builds both surfaces (setting `VITE_APP_SURFACE` and `VITE_APP_HOSTNAME` for each) and publishes to the two Pages projects. Build failures abort before any upload, so partial Pages deploys are impossible.
4. If the Worker step fails, the dashboard job never starts. If dashboard upload fails after the Worker succeeded, use §3.2 to retry only the dashboards.

### 3.2 Dashboard-only hotfix

1. Trigger `Dashboard Pages Deploy` workflow with an optional `ref`.
2. Same `pnpm dashboard:deploy:pages` path; the Worker is not touched.
3. Use sparingly — e.g. Supabase anon key rotation or a UI-only fix.

## 4. Post-deploy checks

- `https://console.memorynode.ai` and `https://app.memorynode.ai` return 200 with the expected surface.
- Browser dev tools: network requests hit `https://api.memorynode.ai`.
- Sign-in via Supabase Google OAuth succeeds; after redirect, `POST /v1/dashboard/session` sets `mn_session` cookie + returns a CSRF token.
- `GET /v1/dashboard/overview-stats` returns data.

## 5. Rollback

Use the Cloudflare Pages UI: select the affected project (`memorynode-console` or `memorynode-app`), open *Deployments*, and promote the previous successful deployment. Past deployments stay uploaded even though the Git integration is disconnected.

If the cause is a bad commit, re-run `Dashboard Pages Deploy` (hotfix) with an explicit `ref` pointing to the last known good SHA. Use the coupled `API Deploy` path only if the Worker also needs to roll forward.

## 6. Adding or rotating Supabase keys

1. Update the Supabase project keys.
2. In GitHub repo settings → Environments → `production`, update `DASHBOARD_VITE_SUPABASE_URL` / `DASHBOARD_VITE_SUPABASE_ANON_KEY`.
3. Re-trigger `Dashboard Pages Deploy` (hotfix) to rebuild with the new key without redeploying the Worker. The Worker's Supabase secrets (see [PROD_SETUP_CHECKLIST.md](../PROD_SETUP_CHECKLIST.md)) are independent and rotated with `wrangler secret put`.

## 7. Related

- Session cookie + CSRF: [DASHBOARD_SESSION_SETUP.md](./DASHBOARD_SESSION_SETUP.md).
- Supabase OAuth handoff: [SUPABASE_GOOGLE_OAUTH_SETUP.md](./SUPABASE_GOOGLE_OAUTH_SETUP.md).
- Worker deploy (API): [RELEASE_RUNBOOK.md](./RELEASE_RUNBOOK.md).
