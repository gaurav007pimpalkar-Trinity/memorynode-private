# MemoryNode.ai — Full Technical & Product Audit

**Role:** Senior external CTO performing code-validated audit  
**Scope:** Repository + git history; documentation not assumed correct  
**Date:** 2026-02-28

---

## PHASE 1 — Repository & Architecture Scan

### 1.1 Architecture Map (validated from code)

| Layer | Technology | Location | Notes |
|-------|------------|----------|--------|
| **Frontend** | React 18, Vite 6 | `apps/dashboard` | SPA; Cloudflare Pages (`memorynode-dashboard`). Supabase Auth (magic link, GitHub OAuth). MemoryNode API via session cookie + CSRF. |
| **Backend API** | Cloudflare Worker (Node compat) | `apps/api` | Single Worker `memorynode-api`. Entry: `src/index.ts` → `handleRequest()` in `workerApp.ts`. No Express/Fastify. |
| **Workers / jobs** | None in Worker | — | No cron in `wrangler.toml`. Session cleanup, webhook reprocess, memory hygiene are **HTTP endpoints** called by **external** GitHub Action (`memory-hygiene.yml` weekly) or manually. |
| **Database** | PostgreSQL (Supabase) | External | Schema in `infra/sql/` (27 migrations). Worker uses `@supabase/supabase-js` (service role). Migrations: `scripts/db_migrate.mjs`; `pnpm deploy:prod` runs `db:check` (migrate + verify). |
| **Rate limiting** | Durable Object | `apps/api/src/rateLimitDO.ts` | Bound as `RATE_LIMIT_DO`. Per-key limits (default 60/min; new keys 15/min for 48h). |
| **External integrations** | OpenAI, PayU, Supabase Auth | Env | Embeddings: OpenAI (or `stub`). Billing: PayU (India); webhook signature; verify-before-grant. Dashboard auth: Supabase Auth + `dashboard_sessions`. |
| **Auth** | Dual path | `auth.ts`, `dashboardSession.ts` | (1) API key: `x-api-key` or `Bearer`; hashed with salt; lookup in `api_keys`. (2) Dashboard: cookie `mn_dash_session` + `x-csrf-token`; production requires `ALLOWED_ORIGINS`. |
| **Infrastructure** | Cloudflare | wrangler.toml | Worker: `memorynode-api` (staging: `memorynode-api-staging`). Production route in code: `api.memorynode.ai/*` (added in latest commit). Dashboard: Pages. |
| **Deployment** | Scripts | `scripts/deploy_*.mjs` | No auto-deploy on push. `deploy:prod` runs release gate, `db:check` (migrate + verify), wrangler deploy, post-deploy smoke. |

### 1.2 Entry Points & Critical Paths

- **HTTP:** `index.ts` `fetch()` → `handleRequest()` (workerApp) → body size → CORS → health/ready → Supabase client → dashboard session routes or `route()` → handler → audit + response.
- **Add memory:** POST `/v1/memories` → auth (API key or dashboard) → rate limit → parse → `handleCreateMemory` → `embedText` (OpenAI with retry or stub) → chunk → insert memories + memory_chunks + bump_usage.
- **Search:** POST `/v1/search` → auth → rate limit → `performSearch` (workerApp) → RPC `match_chunks_vector` / `match_chunks_text` / hybrid RRF → response.
- **Billing:** PayU callback POST `/v1/billing/webhook` → signature check → idempotency via `payu_webhook_events` → reconcile → workspace plan/entitlements.

### 1.3 Core Business Logic Locations

- **workerApp.ts** (~3510 lines): `embedText`, `fetchWithRetry`, `chunkText`, `performSearch`, `performListMemories`, PayU helpers, `reconcilePayUWebhook`, `buildPayURequestHashInput`, export/import helpers, handler wiring. **This file is excluded from test coverage** (vitest.config.ts line 18).
- **handlers/** (memories, search, context, usage, billing, webhooks, admin, export, import, workspaces, apiKeys, eval): Thin wrappers; heavy logic in workerApp or RPCs.
- **DB:** All writes/reads via Supabase client or RPCs; no raw SQL in app code. RLS and RPCs in `infra/sql/`.

### 1.4 Feature Flags / Env

- `EMBEDDINGS_MODE`: `openai` | `stub`
- `RATE_LIMIT_MODE`: `on` | `off` (forbidden in prod)
- `BILLING_WEBHOOKS_ENABLED`: `1` | `0`
- `ALLOWED_ORIGINS`: required for dashboard in production
- No feature-flag framework; toggles are env vars.

### 1.5 Hidden Coupling & Technical Debt

- **workerApp.ts** is a ~3.5k-line god-module. Handlers are split but most helpers and PayU/reconcile logic live in workerApp. **Excluded from coverage** so regression risk on this file is not measured.
- Dashboard depends on Supabase (auth, RPCs for workspaces/members/invites) and MemoryNode API (session, keys, search, usage, billing). Wrong `ALLOWED_ORIGINS` or missing `SUPABASE_ANON_KEY` breaks dashboard in prod.
- **Migrations:** Order is numeric (001–027); drift test in CI uses local Postgres. Production: `deploy:prod` runs `db:check` (migrate + verify) if DB URL is set.
- **Production route:** `wrangler.toml` now has `routes = [{ pattern = "api.memorynode.ai/*", zone_name = "memorynode.ai" }]` for production. Cloudflare audit (2026-02-27) reported memorynode-api had no zone route—either deploy had not been run with this config or audit predates the commit. **Action:** Confirm after next production deploy that `api.memorynode.ai` hits the Worker.

### 1.6 Validation Summary

| Question | Assessment |
|----------|------------|
| Architecture coherent? | Yes: single Worker API, Supabase DB+Auth, dashboard SPA, DO for rate limit. |
| Separation of concerns? | Partial: router/handlers split; workerApp is a monolith and excluded from coverage. |
| Scalability bottlenecks? | Worker scales with CF; DB and OpenAI are external limits; no queue for heavy/async work. |
| Security handled correctly? | API key hashing, RLS, CSRF, webhook signature, admin token. Session and admin paths under-tested. |

---

## PHASE 2 — Product Reality Check

### 2.1 Features (as implemented in code)

| Feature | Status | Evidence |
|---------|--------|----------|
| Create/list/get/delete memories | Implemented | handlers/memories.ts, workerApp performListMemories, RPCs, tests. |
| Search (vector / keyword / hybrid) | Implemented | performSearch, match_chunks_*, search_mode in contracts. |
| Context (LLM-oriented) | Implemented | handleContext, contracts. |
| Usage today + caps | Implemented | handleUsageToday, bump_usage, capsByPlanCode. |
| Billing (PayU checkout + webhook) | Implemented | Checkout, portal, webhook verify-before-grant, idempotency. |
| Workspaces (create/list) | Implemented | Supabase RPC + POST /v1/workspaces (admin). |
| API keys (create/list/revoke) | Implemented | RPCs + Worker API; last_used_at. |
| Dashboard (session, CSRF, tabs) | Implemented | Session in DB, cookie, CSRF validation; tabs: workspaces, keys, memories, usage, retrieval, activation, settings. |
| Export/import (JSON + ZIP) | Implemented | handlers + tests. |
| Search history + replay | Implemented | /v1/search/history, /v1/search/replay. |
| Eval sets + run eval | Implemented | Router + handlers; **eval handler ~3% coverage**. |
| Admin: webhook reprocess, session cleanup, memory hygiene | Implemented | admin handlers; **admin handler ~19% coverage**. |
| Health / readiness | Implemented | /healthz, /ready (DB check). |
| Status page | Removed | Status app deleted; no status page in repo. |

### 2.2 Partial / Stubbed / Broken / Dead

- **Eval:** Implemented; **~3% coverage** (eval.ts)—high regression risk.
- **Admin:** **~19% coverage**—critical for operations.
- **Dashboard session:** **~41% coverage** (dashboardSession.ts); CSRF and cookie logic under-tested.
- **workerApp.ts:** **Excluded from coverage**—all of embedText, performSearch, PayU reconcile, export/import helpers untested by coverage metrics (integration tests still run through it).
- **Status page:** Removed (app deleted).
- **worker.memorynode.ai:** CNAME to gaurav007pimpalkar.workers.dev; audit flags "possible non-existent Worker".

### 2.3 Core Workflow End-to-End

- **Happy path:** User can sign in (Supabase), create/select workspace, create API key (via dashboard or RPC), add memories (with embed), search, view usage, start PayU checkout. **Yes**, core workflow is implementable end-to-end.
- **Likely production failures:** (1) Missing/wrong `ALLOWED_ORIGINS` or `SUPABASE_ANON_KEY` → dashboard broken. (2) PayU webhook secret or verify URL wrong → billing state wrong. (3) DB not migrated or wrong order → RPC/table missing. (4) If production route was not deployed → api.memorynode.ai 404 or wrong backend. (5) OpenAI timeout: **retry exists** (fetchWithRetry for embeddings and Supabase Auth verify) since recent commit—reduces but does not eliminate failure risk.

### 2.4 Unsafe Assumptions

- **Single salt for API keys:** Env and DB salt can diverge; code treats mismatch as fatal (500). Rotation is manual.
- **Single admin token:** `MASTER_ADMIN_TOKEN`; compromise grants full admin.
- **Migrations:** Run as part of `deploy:prod` only when script is invoked with DB URL; no CI run against real staging DB.
- **No retries for Supabase** in most paths (only Auth verify has retry); DB blips surface as 500.

---

## PHASE 3 — Git History & Stability Analysis

### 3.1 Commit History (validated)

- **~75 commits** on main; **no revert commits** in history.
- **Patterns:** Phased work (Phase 0–6), billing migration to PayU, hardening (secrets, RLS, webhooks, rate limit, retries), CI gates (trust gates, coverage, migrations check, OpenAPI drift).
- **Churn:** High in workerApp, billing, webhooks, migrations; recent SDK, dashboard, retrieval cockpit, production route and launch readiness.

### 3.2 Stability Assessment

- No unfinished feature branches visible; no reverted commits.
- CI: lint, typecheck, build, migration check, OpenAPI check, **test with coverage**, secret scan, trust gates, dependency audit (critical). Smoke and e2e require secrets.
- **Assessment:** Iterative shipping and security hardening. Core modules (memories, search, billing) have had substantial changes; tests and CI are in place. **workerApp remains a single point of failure for coverage** (excluded).

---

## PHASE 4 — Testing & Reliability

### 4.1 Test Coverage (from `pnpm test:coverage` run 2026-02-28)

- **Overall:** 54.77% statements, 44.83% branches, 65.83% functions, 55.69% lines.
- **apps/api/src:** 72.66% statements, 74.88% lines. **workerApp.ts is excluded** from coverage; all its logic is untested by coverage metrics.
- **Gaps:**
  - **dashboardSession.ts:** ~41% (session, CSRF, cookie).
  - **eval.ts:** ~3%.
  - **admin.ts:** ~19%.
  - **memories.ts (handler):** ~29%.
  - **search.ts (handler):** ~34%.
- **Dashboard / shared:** Low (dashboard ~21%, shared 0%).
- **Critical:** Auth, billing, webhooks, export/import, health have tests; eval and admin are under-covered.

### 4.2 CI/CD

- **CI:** Lint, typecheck, build, migration sequence check, OpenAPI drift, **test with coverage** (thresholds: lines 50%, statements 50%, functions 45%, branches 40%), secret scan, trust gates, dependency audit (critical). Smoke and e2e require secrets; e2e is manual.
- **Deploy:** Manual; no auto-deploy on merge. `deploy:prod` runs release gate, db:check (migrate + verify), wrangler deploy, post-deploy smoke.
- **Migrations:** Not run in CI against a real staging DB; production apply is part of deploy:prod when run with DB URL.

### 4.3 Failure Modes

| Failure | Behavior |
|---------|----------|
| DB down | Supabase calls fail; /ready returns 503; requests fail with 500/DB_ERROR. |
| OpenAI down/timeout | embedText uses fetchWithRetry (2 retries, 500ms/1s); after that, memory create fails. |
| Rate limit DO unavailable | 503 RATE_LIMIT_UNAVAILABLE. |
| PayU webhook wrong signature | 400; event logged; no state change. |
| Missing ALLOWED_ORIGINS in prod | Dashboard routes get 503 CONFIG_ERROR. |
| Logging | Structured logger; audit log to DB; request_completed/request_failed; redaction. |

---

## PHASE 5 — Production Readiness Score

| Dimension | Score | Notes |
|-----------|-------|--------|
| **Code quality** | 5.5 | TypeScript, ESLint, clear router/handlers; **workerApp is oversized and excluded from coverage**; eval/admin under-tested. |
| **Architecture** | 6 | Coherent single-Worker + Supabase design; no queues/cron in Worker; ops via HTTP + external cron. |
| **Security** | 6 | API key hash, RLS, CSRF, webhook signature, admin token; session and admin paths need more tests; single admin token. |
| **Scalability** | 5 | Worker scales with CF; DB and OpenAI are limits; no job queue. |
| **Observability** | 5 | Health/ready, structured logs, audit table; no APM/traces. |
| **DevOps maturity** | 5.5 | Scripts for deploy, migrate, smoke, gates; deploy:prod runs db:check; no automated staging deploy or CI migration run. |
| **Product completeness** | 6 | Core memory/search/billing/dashboard present; eval incomplete or unexposed. |

**Overall (brutal): 5.5/10** — Usable for early adopters with operational care; not investor-grade production without addressing risks below.

---

## PHASE 6 — Executive Summary (For CEO & CTO)

### 6.1 Is the product truly production-ready?

**Not fully.** Core flows (sign up, workspace, API keys, memories, search, usage, PayU billing) are implemented and partially tested. However: **(1)** Production route for `api.memorynode.ai` is in code but must be confirmed live after deploy. **(2)** The ~3.5k-line core (`workerApp.ts`) is **excluded from test coverage**—regressions there are not measured. **(3)** Critical paths (admin, eval, dashboard session) have low coverage. **(4)** Retries exist for OpenAI embeddings and Supabase Auth verify only; no retries for general Supabase calls. **(5)** Some DNS/Worker records are broken or unconfigured.

### 6.2 Can we confidently sell this?

**Cautiously.** For a small number of customers with clear SLAs and hands-on ops, yes. For "set and forget" or enterprise, no—until coverage of core logic, migrations in CI/staging, and failure handling are improved.

### 6.3 Top 5 technical risks

1. **Core logic untested by coverage** — `workerApp.ts` is excluded from coverage; embed, search, PayU reconcile, and export/import live there. Any regression is invisible to coverage metrics.
2. **Data loss / consistency** — Migrations run only when deploy:prod is run with DB URL; no CI run against staging. Wrong order or missed run can leave schema/RLS out of sync. Admin/eval code paths are under-tested.
3. **Security** — Single MASTER_ADMIN_TOKEN; dashboard session and admin paths under-tested; API key salt rotation is manual and error-prone.
4. **Scaling / availability** — No retry for most Supabase calls; DB blips cause immediate user-facing errors. No queue for heavy or async work.
5. **Customer trust** — Broken or redundant Cloudflare resources in audit; billing depends on correct PayU and webhook config.

### 6.4 What must be fixed before scale?

- **Include workerApp.ts in coverage** (or split it and cover the extracted modules). Aim for >70% on critical paths.
- Confirm production route for `api.memorynode.ai` after deploy and ensure /ready is reachable.
- Add retry/backoff for critical Supabase calls (e.g. workspace/key lookups, session).
- Raise test coverage for admin, eval, and dashboard session.
- Clean up unused/broken DNS and Workers.
- Document runbooks: deploy, migrate, webhook reprocess, session cleanup, memory hygiene, incident response.

### 6.5 If you joined as CTO tomorrow

**Next 7 days**

- Verify production routing (api.memorynode.ai → Worker) and /ready after next deploy.
- Run full regression (sign up → workspace → key → memory → search → usage → billing) on staging and prod.
- Remove workerApp.ts from coverage exclude **or** add targeted integration tests that cover embed, performSearch, and PayU reconcile; ensure coverage threshold still passes.
- Fix or remove broken DNS/Workers (worker.memorynode.ai, 522 Pages).

**Next 30 days**

- Add staging migration run in CI (or mandatory pre-deploy step) and document migration strategy.
- Increase coverage for admin, eval, and dashboard session; add at least one E2E for dashboard login → API key → memory → search.
- Document health/ready endpoints for monitoring.
- Document and test rollback and webhook-reprocess/session-cleanup runbooks.

**Next 90 days**

- Split or reduce workerApp size; extract PayU, embed, and search into testable modules and cover them.
- Harden admin access (e.g. scoped tokens or audit for admin actions).
- Add retries for critical Supabase paths and basic APM/tracing for memory create, search, webhook.
- Re-score production readiness and re-audit infra for investor readiness.

---

*This report is based on code and git history. Documentation was not assumed correct and was validated from the repository. Coverage and test run from 2026-02-28; 210 tests passed.*
