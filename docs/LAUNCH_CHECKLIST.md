# Launch checklist — confirm before go-live

Use this with **docs/LAUNCH_RUNBOOK.md** for deploy and ops. When all items are done, you’re ready to launch.

---

## Code and runbook (done in this pass)

- [x] **OpenAI embeddings retry** — Up to 2 retries with backoff (500ms, 1s) on 5xx, 429, or network errors. (`apps/api/src/workerApp.ts`: `fetchWithRetry` + `embedText`)
- [x] **Supabase Auth verify retry** — Up to 2 retries with backoff for `verifySupabaseAccessToken` (dashboard session). (`apps/api/src/dashboardSession.ts`)
- [x] **Launch runbook** — Single place for deploy, migrations, smoke, health, billing, escalation. (`docs/LAUNCH_RUNBOOK.md`)
- [x] **Migration verify script** — Read-only check that all migrations are applied: `pnpm db:migrate:verify`. (`scripts/db_migrate_verify.mjs`)

---

## You must do (cannot be done in code)

- [ ] **Production API route** — In Cloudflare Dashboard, confirm **api.memorynode.ai** → correct Worker. If missing, add route.
- [ ] **Health/ready** — After deploy: `GET https://api.memorynode.ai/healthz` and `GET https://api.memorynode.ai/ready` return 200.
- [ ] **Dashboard env** — Production Worker has `ALLOWED_ORIGINS` and `SUPABASE_ANON_KEY` set.
- [ ] **Migrations** — Run `pnpm db:migrate` (or `pnpm db:check`) with production DB URL before/with first prod deploy.
- [ ] **Post-deploy smoke** — Run `BASE_URL=https://api.memorynode.ai pnpm prod:smoke` after deploy.
- [ ] **One manual E2E** — Sign in to dashboard → create workspace → create API key → add memory → search.

---

## Ready to launch when

1. All “You must do” items above are checked.
2. You’ve run through the **Launch checklist summary** in `docs/LAUNCH_RUNBOOK.md` once.

No code changes remain for the launch-readiness plan; remaining steps are configuration and verification in your environment.
