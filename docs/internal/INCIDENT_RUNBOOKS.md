# MemoryNode Incident Runbooks

Response playbooks for the `memorynode-api` Cloudflare Worker and the Supabase data plane. Grounded in the code paths named in each section. Alert ids (A1–A3, B1–B3, C1–C2, D1–D4, E1–E2) come from [docs/observability/alert_rules.json](../observability/alert_rules.json) and [ALERTS.md](./ALERTS.md).

---

## 1) On-Call Ownership and Escalation

| Severity | Trigger examples | Primary owner | Escalation window | Escalate to |
| --- | --- | --- | --- | --- |
| SEV-1 | API unavailable, cross-tenant exposure, forged billing grant, data corruption risk | On-call engineer | Immediate | CTO + Security lead |
| SEV-2 | Elevated 5xx, webhook backlog, regional degradation, auth outage | On-call engineer | 15 min | CTO |
| SEV-3 | Localized failures, non-critical automation issues | On-call engineer | 60 min | Team lead |

Hard rule: any suspected data leak or auth bypass is SEV-1 until disproven.

---

## 2) Universal First 5 Minutes

1. Acknowledge the page and open an incident channel.
2. Capture impact from the `request_completed` log: `route_group` (from `classifyRouteGroup` in [apps/api/src/workerApp.ts](../../apps/api/src/workerApp.ts)), `status`, `error_code`.
3. Freeze non-essential deploys (cancel in-flight runs of `.github/workflows/api-deploy.yml` / `dashboard-pages-deploy.yml`).
4. Record evidence:
   - `x-request-id` samples
   - `BUILD_VERSION` / `GIT_SHA` from `/healthz`
   - Latest migration in `infra/sql/`
5. Assign roles: incident commander, operator, recorder.

---

## 3) Playbooks

### 3.1 Auth outage / auth failure spike (A2)

Symptoms
- 401/403 rate spike in `request_completed` (source `authenticate()` + `verifyDashboardSession()` in [apps/api/src/auth.ts](../../apps/api/src/auth.ts)).
- Dashboard session POSTs failing.

Actions
1. Check `/ready` (runs `get_api_key_salt` RPC behind the Supabase circuit breaker). If it returns 503, Supabase is the root cause → jump to 3.2.
2. Verify secrets with `CHECK_ENV=prod pnpm check:config`:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`
   - `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`
3. For dashboard auth failures, exercise `POST /v1/dashboard/session` and `POST /v1/dashboard/logout` directly; confirm CSRF double-submit is present.
4. If API-key hashing changed (salt rotation), rotate `API_KEY_SALT` only via the documented procedure and redeploy.

Recovery validation
- 401/403 rate returns to baseline for 15 min.
- `pnpm release:prod:validate` smoke passes.

### 3.2 DB degradation / RPC failures (E1/E2)

Symptoms
- `db_rpc.success=false` bursts, `DB_ERROR` on `/v1/search`, `/v1/memories`, `/v1/billing/*`.
- p95 `db_latency_ms` crossing E1 thresholds.

Actions
1. Check Supabase status and connectivity from the Worker (circuit breaker state in [apps/api/src/circuitBreakerDo.ts](../../apps/api/src/circuitBreakerDo.ts)).
2. Run `pnpm db:verify-schema` and `pnpm db:verify-rls`.
3. Run `pnpm migrations:check` — ensure the latest migration in `infra/sql/` is applied.
4. If correlated with the latest deploy, roll back the API Worker per 3.5.
5. If caused by hot partition on `memories`/`memory_chunks`, throttle ingest by lowering `WORKSPACE_CONCURRENCY_MAX` temporarily.

Recovery validation
- `db_rpc` error burst resolved.
- p95 `db_latency_ms` below E1 warn.

### 3.3 Billing webhook forgery/replay/surge (D1-D4)

Symptoms
- `billing_webhook_signature_invalid` (D2) burst.
- `webhook_deferred` without matching `webhook_reconciled` (D4 backlog).
- Duplicate settlement attempts.

Actions
1. Verify PayU secrets in Worker env: `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_WEBHOOK_SECRET`.
2. Confirm verify-before-grant is intact: [apps/api/src/handlers/billingWebhook.ts](../../apps/api/src/handlers/billingWebhook.ts) calls `verifyPayUTransactionViaApi` before `upsertWorkspaceEntitlementFromTransaction`.
3. Drain backlog: `POST /admin/webhooks/reprocess` (admin token).
4. If compromise is suspected: rotate PayU merchant salt/webhook secret in the PayU dashboard, rotate the corresponding Worker secrets via `wrangler secret put`, redeploy.

Recovery validation
- New PayU webhooks land without `billing_webhook_signature_invalid`.
- `deferred_count − reconciled_count` back to normal band.

### 3.4 Rate-limit infrastructure outage / abuse spike (B2/B3)

Symptoms
- `rate_limit_do_unavailable` or `rate_limit_binding_missing` logs.
- Unexpected 429 storm, or missing 429 under abuse traffic.

Actions
1. Verify `RATE_LIMIT_DO` binding (scan `wrangler.toml`) and that the v1/v2 DO migrations are applied (`npx wrangler deployments list`).
2. Inspect `getRouteRateLimitMax` and env overrides: `RATE_LIMIT_MAX`, `RATE_LIMIT_SEARCH_MAX`, `RATE_LIMIT_CONTEXT_MAX`, `RATE_LIMIT_IMPORT_MAX`, `RATE_LIMIT_BILLING_MAX`, `RATE_LIMIT_ADMIN_MAX`, `RATE_LIMIT_DASHBOARD_SESSION_MAX`.
3. Active abuse: lower the matching env var, `wrangler secret put`, redeploy; escalate to Cloudflare WAF rule at the edge if needed.
4. `RATE_LIMIT_MODE=off` is forbidden in production (enforced by `validateRateLimitConfig` in [apps/api/src/env.ts](../../apps/api/src/env.ts)); do not disable rate limits.

Recovery validation
- No new `rate_limit_do_unavailable` events.
- 429 rate tracks expected policy.

### 3.5 Release regression / rollback

Symptoms
- 5xx or latency breach starts immediately after a Worker deploy.
- SLOs regress post-release.

Actions
1. Cancel in-flight `api-deploy.yml` runs.
2. `npx wrangler deployments list` → identify last known good.
3. `npx wrangler rollback --message "<incident id>"`.
4. Run `pnpm release:staging:validate` or `pnpm release:prod:validate`.
5. File a corrective PR with failing test coverage before rolling forward.

Recovery validation
- Error rate and p95 back to pre-release baseline.

### 3.6 Key or secret compromise

Symptoms
- Secret surfaced in logs, commits, or chat.
- Unexpected admin action (`x-admin-token` use from unknown IP) or abnormal API key usage.

Actions
1. Rotate the compromised secret with `wrangler secret put <NAME>`.
2. If an API key leaked: `POST /v1/api-keys/revoke` (admin).
3. If `MASTER_ADMIN_TOKEN` leaked: rotate and redeploy; restrict via `ADMIN_ALLOWED_IPS`; enable `ADMIN_AUTH_MODE=signed-required`.
4. Run secret scans: `pnpm secrets:check` and `pnpm secrets:check:tracked`.
5. Audit `api_audit_log` for suspicious `actor_kind="admin"` or forged API-key events.

Recovery validation
- No successful requests using revoked credentials in `api_audit_log` for 24 h.
- No new secret findings in scans.

### 3.7 Memory webhook ingest (H)

Symptoms
- `POST /v1/webhooks/memory` returning 401 after a partner key rotation.
- Sudden inbound ingest surge from a single webhook endpoint.

Actions
1. Confirm the partner's current `memory_ingest_webhooks.signing_secret` matches their signer.
2. If surge-driven, inspect per-workspace concurrency and 429 behavior; temporarily lower `WORKSPACE_CONCURRENCY_MAX`.
3. Review `MEMORY_WEBHOOK_INTERNAL_TOKEN` (Worker-only secret) — it must be set and not logged.

### 3.8 Global AI cost guard trip (`COST_BUDGET_EXCEEDED`)

Symptoms
- `checkGlobalCostGuard` returns 503 for embed/LLM routes.
- Spike in `cap_exceeded` (B1) for cost dimension.

Actions
1. Confirm `AI_COST_BUDGET_INR` and `USD_TO_INR` are correct.
2. Identify top spender via `api_audit_log` and `usage_events`.
3. If organic, raise budget via `wrangler secret put AI_COST_BUDGET_INR` and redeploy.
4. If abuse, revoke offending API keys and tighten per-workspace limits.
5. Never set `AI_COST_GUARD_FAIL_OPEN=1` in production (fail-closed is the intended default).

---

## 4) Validation Checklist (must complete before incident close)

- [ ] Root cause identified and documented.
- [ ] Time-to-detect / time-to-mitigate captured.
- [ ] Impacted workspaces listed (`workspace_id` redacted in shared comms).
- [ ] Corrective action item(s) created with owners and due dates.
- [ ] Tests or guards added to prevent recurrence.
- [ ] Related alert rule in [alert_rules.json](../observability/alert_rules.json) reviewed for tuning.

---

## 5) Required Quarterly Drills

1. Webhook forgery + replay drill (D1–D4).
2. DB latency / failure drill (E1/E2).
3. Deployment rollback drill (3.5).
4. Secret-compromise drill (3.6).

Each drill captures: start/end timestamps, responders, failed assumptions, follow-up hardening tasks.
