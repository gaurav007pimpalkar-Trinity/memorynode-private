# MemoryNode Launch Runbook

One-page reference for deploy, migrations, health checks, and escalation. Use this before and after launch.

---

## Your steps (summary)

1. Confirm **api.memorynode.ai** → Worker (Cloudflare Dashboard).
2. Set **ALLOWED_ORIGINS** and **SUPABASE_ANON_KEY** on production Worker.
3. Run **migrations** with production DB URL (`pnpm db:migrate` or `pnpm db:check`).
4. **Deploy:** `DEPLOY_CONFIRM=memorynode-prod pnpm deploy:prod`.
5. Verify **/healthz** and **/ready** return 200.
6. Run **post-deploy smoke:** `BASE_URL=https://api.memorynode.ai pnpm prod:smoke`.
7. Do **one manual E2E** (see `docs/E2E_CRITICAL_PATH.md`).

---

## Pre-launch checklist (do once)

- [ ] **Production API route**  
  In Cloudflare Dashboard: **Workers & Pages** → **Overview** → confirm **api.memorynode.ai** is routed to the correct Worker (`memorynode-api` or your production Worker). If no route exists, add a route: `api.memorynode.ai/*` → your production Worker.

- [ ] **Health and readiness**  
  After deploy, verify:
  - `GET https://api.memorynode.ai/healthz` → 200
  - `GET https://api.memorynode.ai/ready` → 200 and `{"status":"ok","db":"connected"}`

- [ ] **Dashboard env (production Worker)**  
  In Cloudflare Worker → **Settings** → **Variables and Secrets**, ensure:
  - `ALLOWED_ORIGINS` = e.g. `https://console.memorynode.ai` (comma-separated if multiple)
  - `SUPABASE_ANON_KEY` is set (required for dashboard session / Supabase Auth Get User)

- [ ] **Database migrations**  
  Production DB must have all migrations applied. Use `db:migrate` (see below) with the production DB URL before or as part of first production deploy.

---

## Deploy

### Staging

```bash
# From repo root; ensure env has SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY_SALT, MASTER_ADMIN_TOKEN, etc.
pnpm deploy:staging
```

Optional: run smoke after deploy:

```bash
pnpm smoke:staging
# or: node scripts/smoke_staging.mjs
```

### Production

Production deploy is guarded: it requires `DEPLOY_CONFIRM=memorynode-prod` and runs release gate + db:check + deploy + post-deploy smoke.

```bash
# Set required env (see deploy_prod.mjs for full list), then:
DEPLOY_CONFIRM=memorynode-prod pnpm deploy:prod
```

Or use the deploy-and-smoke wrapper:

```bash
DEPLOY_CONFIRM=memorynode-prod pnpm prod:release-check
```

---

## Migrations

Migrations live in `infra/sql/` and are applied with `db_migrate.mjs`. **Run migrations before or as part of deploy** when you have new SQL files.

- **List migrations:**  
  `pnpm migrations:list`

- **Apply migrations (staging/production):**  
  Set `SUPABASE_DB_URL` or `DATABASE_URL` to your Postgres connection string (e.g. from Supabase project → Settings → Database), then:

  ```bash
  pnpm db:migrate
  ```

- **Full DB check (migrate + verify RLS + verify schema):**  
  ```bash
  pnpm db:check
  ```

- **Verify only (read-only; no apply):**  
  Check that all migrations are already applied without running them:
  ```bash
  SUPABASE_DB_URL=postgresql://... pnpm db:migrate:verify
  ```
  Exits 0 if up to date, 1 and lists missing files if not.

The production deploy script (`deploy_prod.mjs`) runs `db:check` against the production DB before deploying the Worker. Ensure that URL is set correctly in the environment used for deploy.

**CI:** `pnpm migrations:check` runs on every push and validates migration order and numbering; it does not apply migrations. Applying migrations is done only when you run `db:migrate` or `deploy:prod` with a DB URL.

---

## Post-deploy smoke

After any production deploy, run a quick smoke test:

```bash
# Requires: BASE_URL (defaults to workers.dev URL), MASTER_ADMIN_TOKEN, SUPABASE_SERVICE_ROLE_KEY, API_KEY_SALT, SUPABASE_URL
BASE_URL=https://api.memorynode.ai pnpm prod:smoke
```

This hits `/healthz`, creates a workspace, creates an API key, and optionally checks usage. If you use a custom production API URL, set `BASE_URL` to it.

---

## Health and readiness

| Endpoint | Purpose |
|----------|--------|
| `GET /healthz` | Liveness; returns version and stage. |
| `GET /ready` | Deep readiness; checks DB connectivity. Returns 503 if DB is unreachable. |

Use `/ready` for load balancer or monitoring probes if you add them.

---

## Billing (PayU) webhook reprocess

If PayU webhooks were missed or you need to replay deferred events:

```bash
# Call the admin endpoint (requires MASTER_ADMIN_TOKEN and production API URL)
curl -X POST "https://api.memorynode.ai/admin/webhooks/reprocess" \
  -H "x-admin-token: YOUR_MASTER_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"limit":20}'
```

Or use the script if one exists (e.g. `payu:webhook-test` for testing).

---

## Session cleanup (dashboard)

To expire old dashboard sessions:

```bash
curl -X POST "https://api.memorynode.ai/admin/sessions/cleanup" \
  -H "x-admin-token: YOUR_MASTER_ADMIN_TOKEN"
```

---

## Diagnosing "Invalid API key" on workspace / API key create

If `POST /v1/workspaces` or `POST /v1/api-keys` returns `DB_ERROR` with message like "Invalid API key", the error comes from **Supabase** (wrong or mismatched credentials), not from the admin token.

1. **Run the diagnostic script** with the **same** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as your production Worker (from Cloudflare → Worker → Settings → Variables and Secrets):

   ```powershell
   cd apps\api
   $env:SUPABASE_URL = "https://YOUR_PROJECT.supabase.co"
   $env:SUPABASE_SERVICE_ROLE_KEY = "eyJ..."   # service_role secret, not anon
   pnpm run diagnose:workspace
   ```

   If it fails, the script prints the exact Supabase error (e.g. wrong key, JWT expired, wrong project).

2. **Fix:** In Supabase Dashboard → Project Settings → API, copy the **Project URL** and the **service_role** secret (not the anon key). Set those in the Worker as `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, then redeploy.

---

## Escalation

- **API or dashboard down:** Check Cloudflare Worker status and route for `api.memorynode.ai`. Verify `/healthz` and `/ready`. If `/ready` is 503, check Supabase connection and credentials.
- **Migrations out of sync:** Run `pnpm db:migrate` with the correct `SUPABASE_DB_URL`/`DATABASE_URL`. Do not run migrations in parallel against the same DB.
- **Billing state wrong:** Check PayU webhook logs; use admin reprocess endpoint above if needed (see docs for PayU go-live and invariants).

---

## Launch checklist summary

Before going live:

1. Confirm production API route (api.memorynode.ai → Worker).
2. Run migrations for production DB.
3. Set ALLOWED_ORIGINS and SUPABASE_ANON_KEY on production Worker.
4. Deploy with `DEPLOY_CONFIRM=memorynode-prod pnpm deploy:prod` (or `prod:release-check`).
5. Verify `GET https://api.memorynode.ai/healthz` and `GET https://api.memorynode.ai/ready` return 200.
6. Run `pnpm prod:smoke` with `BASE_URL=https://api.memorynode.ai`.
7. Do one manual E2E: sign in to dashboard → create workspace → create API key → add memory → search.

---

*Last updated: 2026-02-28. Part of launch-readiness fixes.*
