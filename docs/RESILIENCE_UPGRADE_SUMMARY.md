# Resilience Upgrade Summary

**Date:** 2026-03-01  
**Scope:** Correctness → Stability → Resilience (no architecture rewrite, no new infrastructure)

---

## 1. List of Modified / Created Files

### New files

| File | Purpose |
|------|--------|
| `apps/api/src/resilienceConstants.ts` | Centralized retry counts, timeouts, backoff delays, circuit-breaker thresholds |
| `apps/api/src/circuitBreaker.ts` | In-memory circuit breaker for `openai` and `supabase` |
| `apps/api/src/supabaseScoped.ts` | `requireWorkspaceId()` — fail-fast when `workspace_id` is missing |
| `apps/api/tests/critical_flows_integration.test.ts` | Integration tests: healthz, ready, auth-required endpoints (memories, search, usage) |
| `apps/api/tests/search_tenant.test.ts` | Cross-tenant isolation tests (search/context do not leak between workspaces) |

### Modified files

| File | Changes |
|------|--------|
| `apps/api/src/workerApp.ts` | Healthz/ready fixes (full payload, env validation, DB probe, CORS/security headers); removed dead health/ready blocks; single `started`; embed timeout + retry + circuit breaker; PayU retry + timeout from constants; ready uses circuit breaker + Supabase retry |
| `apps/api/src/handlers/memories.ts` | Extraction: retry + timeout, return 503 + `EXTRACTION_ERROR` on failure (no silent `[]`); `requireWorkspaceId(auth.workspaceId)` after auth in create-memory |
| `apps/api/src/handlers/search.ts` | `requireWorkspaceId(auth.workspaceId)` after auth in search, list history, replay |
| `apps/api/src/supabaseRetry.ts` | Uses `RETRY_MAX_ATTEMPTS`, `SUPABASE_RETRY_DELAYS_MS` from `resilienceConstants.ts` |
| `apps/api/tests/health_version.test.ts` | Healthz: 200 with version/build_version/stage/embedding_model; 500 when critical env missing; Ready: 503 when Supabase client creation fails |
| `apps/api/tests/config_guard.test.ts` | Adjusted for new healthz 500 shape `{ status, error: { code, message } }`; fixed syntax (missing `});`) |
| `apps/api/tests/request_logging.test.ts` | (No code change; passes after workerApp logs `request_completed` for healthz/ready via `logHealthReadyCompleted`) |

---

## 2. Summary of Resilience Improvements

### Phase 1 — Operational blindness

- **GET /healthz**
  - Returns `status`, `version`, `build_version`, `stage`, `embedding_model` (and `git_sha` when set).
  - Validates critical env (e.g. `SUPABASE_SERVICE_ROLE_KEY`, `API_KEY_SALT`) and stub/rate-limit config in non-dev; returns **500** with structured `error: { code, message }` when invalid.
  - Removed early-return dead code; single code path with proper headers (including CORS) and `request_completed` logging.
- **GET /ready**
  - Performs a real Supabase probe (`app_settings` select limit 1) inside circuit breaker + retry.
  - Returns **503** if DB is unreachable or circuit is open; **200** only when DB is reachable (`status: "ok", db: "connected"`).
  - No silent success; completion logged for every outcome.

**Why it improves resilience:** Health and readiness become honest signals for load balancers and operators; misconfig or DB outage is detected and reported instead of falsely reporting OK.

---

### Phase 2 — Retry & timeout gaps

- **OpenAI chat extraction**
  - Retry (max 2) with exponential backoff and explicit timeout (`AbortController`).
  - On failure: returns **503** with `EXTRACTION_ERROR` instead of silently returning `[]`.
- **PayU verify**
  - Retry (2 attempts) with backoff; idempotency preserved; non-sensitive retry logging; timeout from constants.
- **Embedding fetch**
  - Request-level timeout (e.g. 30s); retry respects abort so timeouts do not stack.

**Why it improves resilience:** Transient failures are retried; runaway calls are bounded by timeouts; extraction failures are visible (503) instead of silent empty results.

---

### Phase 3 — Lightweight circuit breaker

- **In-memory circuit breaker** (no external infra):
  - **Per dependency:** separate breakers for `openai` and `supabase`.
  - **Rule:** 5 consecutive failures within 60s → open for 60s; new requests get **503** immediately.
  - **Recovery:** After 60s, one probe request; success → close; failure → reopen for another 60s.
- Used for: Supabase critical path (e.g. ready probe), OpenAI embed (and extraction path where applicable).
- Lightweight: global map in worker scope; no persistence across deploys; minimal logging (open/close).

**Why it improves resilience:** Reduces retry storms and cascading load when a dependency is down; fails fast with 503 instead of burning CPU and time.

---

### Phase 4 — Tenant safety

- **`requireWorkspaceId(workspaceId)`** in `supabaseScoped.ts`:
  - Throws **400** if `workspace_id` is missing or null.
  - Used after `authenticate` in: create-memory, search, list history, replay.
- **Integration test:** `search_tenant.test.ts` ensures search and context do not leak between workspaces.

**Why it improves resilience:** Prevents cross-tenant data access from misconfiguration or missing context; fail-fast at the edge.

---

### Phase 5 — Core request path coverage

- **critical_flows_integration.test.ts** covers:
  - GET /healthz → 200 with version and embedding_model.
  - GET /ready → 200 with db connected (stub).
  - POST /v1/memories, POST /v1/search, GET /v1/usage/today without auth → **401**.
- **search_tenant.test.ts** covers cross-workspace isolation for search and context.

**Why it improves resilience:** Critical flows are guarded by tests; regressions in health, auth, or tenant isolation are caught before production.

---

### Phase 6 — Dead code & constants

- **Removed:** Unreachable duplicate GET /healthz and GET /ready handlers; duplicate `const started` (single `started` at top of `handleRequest`).
- **Centralized in `resilienceConstants.ts`:**
  - Retry: max attempts, Supabase/OpenAI embed/extract/PayU delay arrays.
  - Timeouts: embed (e.g. 30s), extract (e.g. 15s), PayU (e.g. 10s).
  - Circuit breaker: failure threshold (5), window (60s), open duration (60s).

**Why it improves resilience:** Single place to tune retries and timeouts; no magic numbers; less dead code to confuse behavior.

---

## 3. Behavior Changes (non-breaking)

| Area | Before | After |
|------|--------|--------|
| **Healthz** | Could return minimal `{ status: "ok" }` or skip env validation | Always returns version/build_version/stage/embedding_model; 500 if critical env missing (non-dev) |
| **Ready** | Could succeed without DB check | 503 if DB unreachable or circuit open; 200 only when probe succeeds |
| **Extraction failure** | Often returned 201 with empty items | Returns **503** with `EXTRACTION_ERROR` when extraction fails after retries |
| **Embed / OpenAI** | No request timeout; no circuit breaker | Timeout + retry; 503 when circuit is open |
| **PayU verify** | Single attempt | 2 attempts with backoff; timeout from constants |
| **Memories/Search** | No explicit workspace_id check | `requireWorkspaceId` after auth → 400 if workspace_id missing |

**API shape:** No breaking changes to public request/response contracts; only new or stricter error codes (503, 400) where appropriate.

---

## 4. Follow-up Recommendations (optional)

1. **Billing webhook idempotency:** Add an explicit integration test that duplicates of the same webhook payload return the same result (idempotent).
2. **Rate limiting:** Add a minimal integration test that confirms 429 (or equivalent) when limit is exceeded.
3. **Circuit breaker metrics:** If you add a metrics pipeline later, consider exposing circuit state (open/closed) per dependency for dashboards.
4. **Ready probe in production:** Ensure load balancer uses GET /ready for health checks and that Supabase URL/keys are correct in production env so 503 is accurate.
5. **Staged rollout:** Deploy behind a feature flag or canary and watch for 503/400 rates and latency on embed/extract and ready.

---

## 5. Test Run

- **Full suite:** `pnpm test --run`
- **Result:** 42 test files, 242 tests passed (including request_logging, retry_behavior, health_version, config_guard, critical_flows_integration, search_tenant).

---

**End state:** The system now detects dependency failures, fails fast under cascading failure, avoids retry storms via circuit breakers, provides honest health signals, and is protected against cross-tenant leakage, with test coverage for critical flows.
