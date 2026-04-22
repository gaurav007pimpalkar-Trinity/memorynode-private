# Dashboard Pages Deploy

MemoryNode ships two Cloudflare Pages projects from the single React app at [apps/dashboard](../../apps/dashboard/). Both are built from the same commit and deployed in one job: [.github/workflows/dashboard-pages-deploy.yml](../../.github/workflows/dashboard-pages-deploy.yml).

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

1. `workflow_dispatch` with optional `ref` input.
2. Checkout at `ref` or `github.sha`.
3. `pnpm install --frozen-lockfile`.
4. `Validate deploy secrets` — fails loudly if any of the four secrets above is unset.
5. `pnpm dashboard:deploy:pages` — script runs both surface builds (setting `VITE_APP_SURFACE` and `VITE_APP_HOSTNAME` for each) and publishes to the two Pages projects. Build failures abort before any upload, so partial deploys are impossible.

## 4. Post-deploy checks

- `https://console.memorynode.ai` and `https://app.memorynode.ai` return 200 with the expected surface.
- Browser dev tools: network requests hit `https://api.memorynode.ai`.
- Sign-in via Supabase Google OAuth succeeds; after redirect, `POST /v1/dashboard/session` sets `mn_session` cookie + returns a CSRF token.
- `GET /v1/dashboard/overview-stats` returns data.

## 5. Rollback

Use the Cloudflare Pages UI: select the affected project (`memorynode-console` or `memorynode-app`), open *Deployments*, and promote the previous successful deployment.

If the cause is a bad commit, re-run `workflow_dispatch` with an explicit `ref` pointing to the last known good SHA.

## 6. Adding or rotating Supabase keys

1. Update the Supabase project keys.
2. In GitHub repo settings → Environments → `production`, update `DASHBOARD_VITE_SUPABASE_URL` / `DASHBOARD_VITE_SUPABASE_ANON_KEY`.
3. Re-trigger `Dashboard Pages Deploy`. The Worker's Supabase secrets (see [PROD_SETUP_CHECKLIST.md](../PROD_SETUP_CHECKLIST.md)) are independent and rotated with `wrangler secret put`.

## 7. Related

- Session cookie + CSRF: [DASHBOARD_SESSION_SETUP.md](./DASHBOARD_SESSION_SETUP.md).
- Supabase OAuth handoff: [SUPABASE_GOOGLE_OAUTH_SETUP.md](./SUPABASE_GOOGLE_OAUTH_SETUP.md).
- Worker deploy (API): [RELEASE_RUNBOOK.md](./RELEASE_RUNBOOK.md).
