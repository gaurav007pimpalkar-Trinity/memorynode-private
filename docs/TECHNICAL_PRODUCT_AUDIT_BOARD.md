# MemoryNode.ai — Full Technical & Product Audit

**Prepared for:** Board meeting (funding / technical credibility)  
**Role:** Senior external CTO — code-validated audit  
**Date:** 2026-02-28  
**Scope:** Repository + git history; documentation not assumed correct.

---

## PHASE 1 — Repository & Architecture Scan

### 1.1 Architecture Map (validated from code)

| Layer | Technology | Location | Notes |
|-------|------------|----------|--------|
| **Frontend** | React 18, Vite | `apps/dashboard` | SPA; deploys to Cloudflare Pages (`memorynode-dashboard`). Uses Supabase Auth (magic link, GitHub OAuth) and MemoryNode API with session cookie + CSRF. |
| **Backend API** | Cloudflare Worker (Node compat) | `apps/api` | Single Worker `memorynode-api`; entry `src/index.ts` → `handleRequest()` in `workerApp.ts`. No separate server. |
| **Workers / jobs** | None in Worker | — | No cron/scheduled triggers in `wrangler.toml`. Admin maintenance (session cleanup, webhook reprocess, memory hygiene) are **HTTP endpoints** called manually or by **external** GitHub Action (e.g. `memory-hygiene.yml` weekly). |
| **Database** | PostgreSQL (Supabase) | External | Schema in `infra/sql/` (27 migrations). **Not** D1; Worker uses `@supabase/supabase-js` with service role. Migrations run via `scripts/db_migrate.mjs` (requires `SUPABASE_DB_URL` or `DATABASE_URL`). |
| **Rate limiting** | Durable Object | `apps/api/src/rateLimitDO.ts` | In-process; bound as `RATE_LIMIT_DO`. Per-key limits (default 60/min; new keys 15/min for 48h). |
| **External integrations** | OpenAI, PayU, Supabase Auth | Env/secrets | Embeddings: OpenAI only (or `stub`). Billing: PayU (India); webhook signature verification; verify-before-grant. Dashboard auth: Supabase Auth (Get User) + dashboard_sessions in DB. |
| **Auth** | Dual path | `apps/api/src/auth.ts`, `dashboardSession.ts` | (1) **API key:** `x-api-key` or `Bearer`; hashed with salt (env + optional `app_settings.api_key_salt`); lookup in `api_keys`. (2) **Dashboard:** Cookie `mn_dash_session` + CSRF header `x-csrf-token`; session in `dashboard_sessions`; production requires `ALLOWED_ORIGINS`. |
| **Infrastructure** | Cloudflare | wrangler.toml, docs | Worker: `memorynode-api` (staging: `memorynode-api-staging`). Dashboard: Pages. DNS/zone: `memorynode.ai` (see CLOUDFLARE_INFRASTRUCTURE_AUDIT.md). |
| **Deployment** | Scripts + manual | `scripts/deploy_*.mjs` | `deploy:staging` / `deploy:prod`; no automated deploy on push. Migrations are **manual** (`pnpm db:migrate` with DB URL). |

### 1.2 Entry Points & Critical Paths

- **HTTP:** `index.ts` `fetch()` → `handleRequest()` → body size check → CORS → health/ready → Supabase client creation → dashboard session routes or `route()` (router) → handler → audit log + response.
- **Critical path for "add memory":** POST `/v1/memories` → auth (API key or dashboard) → rate limit → parse body → `handleCreateMemory` → embed (OpenAI or stub) → chunk → insert memories + memory_chunks + usage bump.
- **Critical path for billing:** PayU callback POST `/v1/billing/webhook` → signature check (`PAYU_WEBHOOK_SECRET`) → idempotency via `payu_webhook_events` → reconcile → update workspace plan/status.

### 1.3 Core Business Logic

- **Memories:** Create (with optional extraction/typing), list, get, delete. Chunking + vector embed (OpenAI 1536) + full-text `tsvector`; search via `match_chunks_vector` / `match_chunks_text` / hybrid.
- **Usage:** `usage_daily` per workspace/day; RPC `bump_usage`; plan caps enforced in handlers.
- **Billing:** PayU; checkout form build; webhook reconcile with verify-before-grant; entitlements in DB.
- **Dashboard:** Workspaces and API keys can be created via **Supabase RPCs** (`create_workspace`, `create_api_key`, etc.) with JWT, or via Worker API with `x-admin-token`. Two paths must stay aligned (e.g. same `API_KEY_SALT` / hashing).

### 1.4 Feature Flags / Env

- `EMBEDDINGS_MODE`: `openai` | `stub`
- `SUPABASE_MODE`: real URL vs `stub` (tests)
- `RATE_LIMIT_MODE`: `on` | `off` (off forbidden in prod)
- `BILLING_WEBHOOKS_ENABLED`: `1` | `0`
- `ALLOWED_ORIGINS`: comma-separated (required for dashboard in production)
- No feature-flag framework; toggles are env vars.

### 1.5 Hidden Coupling & Technical Debt

- **workerApp.ts** is a very large single file (~3.5k+ lines); handlers are split but many deps and helpers live in workerApp. Router lists many handlers; some eval/search routes have low test coverage.
- **Dashboard** depends on both Supabase (auth, RPCs for workspaces/members/invites/activation) and MemoryNode API (session, keys, search, usage, billing). Misconfiguration (e.g. wrong `ALLOWED_ORIGINS` or missing `SUPABASE_ANON_KEY`) breaks dashboard in prod.
- **Migrations:** Order is numeric (`001_` … `027_`); drift test in CI uses local Postgres. Production DB must be migrated manually; no automated migration on deploy.
- **Production API route:** Cloudflare audit doc (2026-02-27) states **memorynode-api** Worker has **no zone route**; only **memorynode-api-staging** has a route (`api-staging.memorynode.ai/*`). If production traffic for `api.memorynode.ai` is intended to hit `memorynode-api`, the route must be confirmed in the dashboard (API may not expose it). Same doc notes `/ready` returned **404** at time of check—either deploy lag or routing issue.

### 1.6 Validation Summary

| Question | Assessment |
|----------|------------|
| Architecture coherent? | Yes: single Worker API, Supabase DB+Auth, dashboard SPA, DO for rate limit. |
| Separation of concerns? | Partial: router/handlers are split; workerApp remains a god-module. |
| Scalability bottlenecks? | Single Worker (scale with CF); DB and OpenAI are external bottlenecks; no queue for heavy jobs. |
| Security handled correctly? | API key hashing, RLS, CSRF, webhook signature, admin token. Gaps: dashboard session 15% coverage; eval/admin handlers under-tested. |

---

## PHASE 2 — Product Reality Check

### 2.1 Features (as implemented in code)

| Feature | Status | Evidence |
|---------|--------|----------|
| Create/list/get/delete memories | Implemented | Handlers + RPCs + tests. |
| Search (vector / keyword / hybrid) | Implemented | `performSearch`, `match_chunks_*`, search modes in contracts. |
| Context (LLM-oriented) | Implemented | `handleContext`, OpenAI chat completions. |
| Usage today + caps | Implemented | `handleUsageToday`, `bump_usage`, plan limits. |
| Billing (PayU checkout + webhook) | Implemented | Checkout, portal, webhook with verify-before-grant, idempotency. |
| Workspaces (create/list) | Implemented | Via Supabase RPC and Worker POST /v1/workspaces. |
| API keys (create/list/revoke) | Implemented | Supabase RPCs + Worker API; last_used_at in 025. |
| Dashboard (session, CSRF, tabs) | Implemented | Session in DB, cookie, CSRF header validation. |
| Export/import (JSON + ZIP) | Implemented | Handlers + tests. |
| Search history + replay | Implemented | `/v1/search/history`, `/v1/search/replay`. |
| Eval sets + run eval | Implemented | Router + handlers; **eval handler ~3% coverage**—high risk. |
| Admin: webhook reprocess, session cleanup, memory hygiene | Implemented | Admin routes; **admin handler ~19% coverage**. |
| Health / readiness | Implemented | `/healthz`, `/ready` (DB check). |
| Status page | Removed | Status app deleted; no status page in repo. |

### 2.2 Partial / Stubbed / Broken / Dead

- **Eval:** Implemented but barely tested (3% coverage in eval.ts); regression risk.
- **Admin:** Low coverage (19%); critical for operations.
- **Dashboard session flow:** Low coverage (dashboardSession.ts 15%); CSRF and cookie logic need more tests.
- **Status page:** Removed (app deleted).
- **memorynode Pages project:** Audit reports 522 (origin unreachable); second Pages project may be redundant if dashboard is on app.memorynode.ai elsewhere.
- **worker.memorynode.ai:** CNAME to gaurav007pimpalkar.workers.dev; audit flags as "possible non-existent Worker".

### 2.3 Core Workflow End-to-End

- **Happy path:** User can sign in (Supabase), create/select workspace, create API key, add memories (with embed), search, view usage, and (if PayU configured) start checkout. So **yes**, core workflow is implementable end-to-end.
- **Likely production failures:** (1) Missing or wrong `ALLOWED_ORIGINS` / `SUPABASE_ANON_KEY` → dashboard broken. (2) PayU webhook secret or verify URL misconfiguration → billing state wrong. (3) DB not migrated or migration order wrong → RPC/table missing. (4) `memorynode-api` route missing for api.memorynode.ai → 404 or wrong backend. (5) OpenAI timeout/failure with no retry → memory create fails.

### 2.4 Unsafe Assumptions

- **Single salt for API keys:** Env and DB salt can diverge; code treats mismatch as fatal (500). Rotation story is manual.
- **No retries:** No backoff/retry for Supabase or OpenAI in the main path; transient failures surface as errors.
- **Manual migrations:** Deploy does not run migrations; operator must run `db:migrate` with production URL.
- **Admin token:** Single `MASTER_ADMIN_TOKEN`; compromise grants full admin.

---

## PHASE 3 — Git History & Stability

- **Commits:** ~75 on main; no revert commits found in codebase search.
- **Patterns:** Phased feature work (Phase 0–6), billing migration to PayU, hardening (secrets, RLS, webhooks, rate limit), CI gates (trust gates, coverage, migrations check).
- **Churn:** Significant changes in workerApp, billing, webhooks, migrations; recent work on SDK, dashboard, and retrieval cockpit.
- **Assessment:** History suggests iterative shipping and security hardening. No large, untested refactors detected; CI runs tests and migration checks. Stability trend is improving but core modules (memories, search, billing) have seen substantial changes.

---

## PHASE 4 — Testing & Reliability

### 4.1 Test Coverage (from `pnpm test:coverage`)

- **Overall:** ~54% statements, ~45% branches, ~65% functions, ~55% lines.
- **apps/api/src:** ~70% statements, ~72% lines. Gaps:
  - **dashboardSession.ts:** ~15% (session, CSRF, cookie).
  - **eval.ts:** ~3%.
  - **admin.ts:** ~19%.
  - **memories.ts:** ~29%.
  - **search.ts:** ~34%.
- **Dashboard / shared:** Low or 0% (dashboard 21%, shared 0%).
- **Critical flows:** Auth, billing, webhooks, export/import, health have tests; eval and admin are under-covered.

### 4.2 CI/CD

- **CI:** Lint, typecheck, build, migration sequence check, OpenAPI drift, **test with coverage**, secret scan, trust gates, dependency audit (critical). Smoke (and optional e2e) require secrets.
- **Deploy:** Manual; no auto-deploy on merge. Staging/prod deploy scripts exist.
- **Migrations:** `migrations:check` validates ordering; `db:drift:test` runs against local Postgres. **Migrations are not run in CI against a real staging DB**; production apply is manual.

### 4.3 Failure Modes

| Failure | Behavior |
|---------|----------|
| DB down | Supabase client calls fail; `/ready` returns 503; request fails with 500/DB_ERROR. |
| OpenAI down/timeout | Embed fails; memory create fails; no retry. |
| Rate limit DO unavailable | 503 RATE_LIMIT_UNAVAILABLE. |
| PayU webhook wrong signature | 400; event logged; no state change. |
| Missing ALLOWED_ORIGINS in prod | Dashboard routes get 503 CONFIG_ERROR. |
| Retry logic | Only for rate-limit response headers (Retry-After). No retry for external HTTP (OpenAI, Supabase) in main path. |
| Logging | Structured logger; audit log to DB; request_completed/request_failed; redaction for secrets. |

---

## PHASE 5 — Production Readiness Scores (0–10)

| Dimension | Score | Notes |
|-----------|-------|--------|
| **Code quality** | 6 | TypeScript, ESLint, clear router/handlers; workerApp is oversized; some handlers under-tested. |
| **Architecture** | 6 | Coherent single-Worker + Supabase design; no queues/cron in Worker; manual ops for maintenance. |
| **Security** | 6 | API key hash, RLS, CSRF, webhook signature, admin token; session and admin paths need more tests; single admin token. |
| **Scalability** | 5 | Worker scales with CF; DB and OpenAI are limits; no horizontal job queue. |
| **Observability** | 5 | Health/ready, structured logs, audit table; no APM/traces. |
| **DevOps maturity** | 5 | Scripts for deploy, migrate, smoke, gates; migrations manual; no automated staging deploy or migration run. |
| **Product completeness** | 6 | Core memory/search/billing/dashboard present; eval incomplete or unexposed. |

**Overall (brutal):** **5.5/10** — Usable for early adopters with operational care; not yet "investor-grade" production without addressing risks below.

---

## PHASE 6 — Executive Summary (CEO & CTO)

### 6.1 Is the product truly production-ready?

**Not fully.** Core flows (sign up, workspace, API keys, memories, search, usage, PayU billing) are implemented and tested to a reasonable level. However: **(1)** Production API route for `api.memorynode.ai` is unclear (Worker "memorynode-api" reported with no zone route). **(2)** Migrations are manual and not run as part of deploy. **(3)** Critical operational endpoints (admin, eval) and dashboard session have low test coverage. **(4)** No retries for OpenAI/Supabase; single points of failure. **(5)** One Pages project is broken or unconfigured.

### 6.2 Can we confidently sell this?

**Cautiously.** For a small number of customers with clear SLAs and hands-on ops, yes. For "set and forget" or enterprise, no—until routing, migrations, coverage, and failure handling are improved.

### 6.3 Top 5 technical risks

1. **Production API routing and /ready** — memorynode-api has no zone route in the audit; `/ready` returned 404. Risk: downtime or traffic to wrong/no backend.
2. **Data loss / consistency** — No automated migrations; wrong order or missed run can leave schema/RLS out of sync. PayU webhook idempotency is present but admin/eval code paths are under-tested.
3. **Security** — Single MASTER_ADMIN_TOKEN; dashboard session and admin paths under-tested; API key salt rotation is manual and error-prone.
4. **Scaling / availability** — No retry for OpenAI or Supabase; DB or OpenAI blips cause immediate user-facing errors. No queue for heavy or async work.
5. **Customer trust** — Incomplete or broken Pages/worker records in audit; billing depends on correct PayU and webhook config—misconfiguration leads to wrong plan or failed checkout.

### 6.4 What must be fixed before scale?

- Confirm and document production route for `api.memorynode.ai` and ensure `/ready` is deployed and reachable.
- Run migrations as part of release (or mandatory pre-deploy step) and add a migration check against staging.
- Add retry/backoff for OpenAI and critical Supabase calls (at least for embeddings and session/workspace lookups).
- Raise test coverage for admin, eval, and dashboard session (target >70% on critical paths).
- Clean up unused/broken Cloudflare resources (Pages/worker).
- Document runbooks for: deploy, migrate, webhook reprocess, session cleanup, memory hygiene, and incident response.

### 6.5 If you joined as CTO tomorrow

**Next 7 days**

- Verify production routing (api.memorynode.ai → which Worker) and fix if wrong; ensure `/ready` is live.
- Run full regression (sign up → workspace → key → memory → search → usage → billing) on staging and prod.
- Add retry (e.g. 1–2 retries with backoff) for OpenAI embeddings and, if feasible, Supabase in auth/session path.
- Fix or remove broken DNS/Pages/worker (memorynode Pages 522, worker.memorynode.ai).

**Next 30 days**

- Automate migration run (e.g. in release pipeline or mandatory pre-deploy step) and add staging migration verification in CI.
- Increase coverage for admin, eval, and dashboard session; add at least one E2E that covers dashboard login → API key → memory → search.
- Document health/ready endpoints for monitoring.
- Document and test rollback and webhook-reprocess/session-cleanup runbooks.

**Next 90 days**

- Split or reduce workerApp size; consider a small job queue (e.g. Cloudflare Queue) for deferred work if product needs it.
- Harden secrets and admin access (e.g. scoped admin tokens or audit for admin actions).
- Add basic APM or tracing for critical paths (memory create, search, webhook).
- Re-score production readiness and re-audit infra (DNS, Workers, Pages) for investor readiness.

---

*This report is based on code and git history only. Documentation was not assumed correct and was validated where referenced.*
