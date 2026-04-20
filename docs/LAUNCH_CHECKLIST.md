# Launch checklist — confirm before go-live

Use this with **docs/LAUNCH_RUNBOOK.md** for deploy and ops. When all items are done, you’re ready to launch.

---

## Code and runbook (done)

- [x] **OpenAI embeddings retry** — Up to 2 retries with backoff on 5xx, 429, or network errors. (`workerApp.ts`: `fetchWithRetry` + `embedText`)
- [x] **Supabase retries** — Critical path (auth salt, API key lookup, dashboard session read/create, project plan lookup, /ready probe) use `withSupabaseQueryRetry`. (`supabaseRetry.ts`, `auth.ts`, `dashboardSession.ts`, `workerApp.ts`)
- [x] **Supabase Auth verify retry** — Up to 2 retries for `verifySupabaseAccessToken`. (`dashboardSession.ts`)
- [x] **Launch runbook** — `docs/LAUNCH_RUNBOOK.md`
- [x] **Migration verify script** — `pnpm db:migrate:verify`
- [x] **Admin and dashboard session tests** — `admin_handlers.test.ts`, `dashboard_session.test.ts`, `supabase_retry.test.ts`

---

## Your steps (in order)

Do these yourself; they cannot be automated in the repo.

| # | Step | How |
|---|------|-----|
| 1 | **Production API route** | Confirm in Cloudflare Dashboard that **api.memorynode.ai** is routed to your production Worker. (If you’ve already hooked the worker to api.memorynode.ai, mark this done.) |
| 2 | **Dashboard env** | In Worker → Settings → Variables and Secrets, set `ALLOWED_ORIGINS` (e.g. `https://console.memorynode.ai`) and `SUPABASE_ANON_KEY`. |
| 3 | **Migrations** | Run `pnpm db:migrate` or `pnpm db:check` with production DB URL (`SUPABASE_DB_URL` or `DATABASE_URL`) before or as part of first prod deploy. |
| 4 | **Deploy** | `DEPLOY_CONFIRM=memorynode-prod pnpm deploy:prod` (with required env set). |
| 5 | **Health/ready** | After deploy: `GET https://api.memorynode.ai/healthz` and `GET https://api.memorynode.ai/ready` both return 200. |
| 6 | **Post-deploy smoke** | `BASE_URL=https://api.memorynode.ai pnpm prod:smoke` (with secrets set). |
| 7 | **One manual E2E** | Sign in to dashboard -> create project -> create API key -> add memory -> search. See **docs/E2E_CRITICAL_PATH.md** for the exact flow. |
| 8 | **PayU (if using billing)** | Confirm webhook URL and secret in PayU; trigger a test and verify entitlement/plan in dashboard. |

---

## Ready to launch when

1. All “Your steps” above are done.
2. You’ve run through the **Launch checklist summary** in `docs/LAUNCH_RUNBOOK.md` once.
