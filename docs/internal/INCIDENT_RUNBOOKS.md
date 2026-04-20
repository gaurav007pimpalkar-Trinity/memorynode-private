## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# MemoryNode Incident Runbooks

Canonical response playbooks for high-impact incidents. This document is optimized for first 15 minutes of response, ownership, escalation, and recovery validation.

---

## 1) On-Call Ownership and Escalation

| Severity | Trigger examples | Primary owner | Escalation window | Escalate to |
| --- | --- | --- | --- | --- |
| SEV-1 | API unavailable, cross-tenant exposure, forged billing grant, data corruption risk | On-call engineer | Immediate | CTO + Security lead |
| SEV-2 | Elevated 5xx, webhook backlog, regional degradation, auth outage | On-call engineer | 15 min | CTO |
| SEV-3 | Localized failures, non-critical automation issues | On-call engineer | 60 min | Team lead |

**Hard rule:** for any suspected data leak or auth bypass, treat as **SEV-1** until disproven.

---

## 2) Universal First 5 Minutes

1. Acknowledge alert/page and open incident channel.
2. Capture current impact: route groups, error rates, impacted projects.
3. Freeze non-essential deploys.
4. Record evidence:
   - `x-request-id` samples
   - failing endpoints
   - current commit SHA and deploy timestamp
5. Assign roles:
   - **Incident commander** (decision + comms)
   - **Operator** (executes changes)
   - **Recorder** (timeline + actions)

---

## 3) Playbooks

## 3.1 Auth outage / auth failure spike (A2)

**Symptoms**
- 401/403 spikes in `request_completed`
- dashboard login/session failures

**Actions**
1. Validate environment secrets and stage:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
   - `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`
2. Run config checks:
   - `pnpm check:config` with `CHECK_ENV=<stage>`
3. Verify dashboard session endpoints:
   - `POST /v1/dashboard/session`
   - `POST /v1/dashboard/logout`
4. If token rotation suspected, rotate and redeploy via release runbook.

**Recovery validation**
- 401/403 rate returns to baseline
- smoke (`pnpm release:staging:validate` / `pnpm release:prod:validate`) passes

---

## 3.2 DB degradation / RPC failures (E1/E2)

**Symptoms**
- `DB_ERROR`, `db_rpc.success=false`, p95 DB latency spikes

**Actions**
1. Confirm DB status and network reachability.
2. Run schema/rls integrity checks against target DB:
   - `pnpm db:verify-schema`
   - `pnpm db:verify-rls`
3. Identify recent migration/deploy:
   - `pnpm migrations:check`
4. If correlated with release, rollback API to last known good revision.

**Recovery validation**
- `db_rpc` error burst resolved
- p95 `db_latency_ms` below alert threshold

---

## 3.3 Billing webhook forgery/replay/surge (D1-D4)

**Symptoms**
- `billing_webhook_signature_invalid` burst
- deferred backlog growth
- repeated replay activity

**Actions**
1. Verify billing secrets present and valid:
   - `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_WEBHOOK_SECRET`
2. Confirm verify-before-grant path is healthy.
3. Drain deferred backlog:
   - `POST /admin/webhooks/reprocess`
4. If compromise suspected:
   - rotate PayU secrets
   - rotate Worker secrets
   - redeploy

**Recovery validation**
- new webhooks process normally
- deferred backlog returns to normal band

---

## 3.4 Rate-limit infrastructure outage / abuse spike (B2/B3)

**Symptoms**
- `rate_limit_do_unavailable` / `rate_limit_binding_missing`
- sudden 429 spikes or abnormal high request volume

**Actions**
1. Confirm `RATE_LIMIT_DO` binding and migrations are present.
2. Verify current per-route limits:
   - `RATE_LIMIT_*` env vars
3. For active abuse, tighten route caps (search/context/import/admin/session) and redeploy.
4. For persistent issue, enable upstream WAF/rules at edge.

**Recovery validation**
- no new limiter unavailability events
- 429 behavior matches expected policy

---

## 3.5 Release regression / rollback

**Symptoms**
- errors begin immediately after deploy
- SLOs regress post-release

**Actions**
1. Stop further deploys.
2. Rollback to previous known-good revision.
3. Re-run post-deploy validation:
   - `pnpm release:staging:validate` or `pnpm release:prod:validate`
4. Open corrective PR with failing test coverage before next rollout.

**Recovery validation**
- error/latency normalize to pre-release baseline

---

## 3.6 Key or secret compromise

**Symptoms**
- leaked tokens in logs/chats/commits
- unexplained admin actions or suspicious API key usage

**Actions**
1. Rotate compromised secret(s) immediately.
2. Revoke affected API keys/admin access.
3. Run secret scans:
   - `pnpm secrets:check`
   - `pnpm secrets:check:tracked`
4. Redeploy and monitor for continued abuse.

**Recovery validation**
- no successful requests using revoked credentials
- no new secret findings in scans

---

## 4) Validation Checklist (must complete before incident close)

- [ ] Root cause identified and documented.
- [ ] Time-to-detect / time-to-mitigate captured.
- [ ] Impacted users/projects listed.
- [ ] Corrective action item(s) created with owners and due dates.
- [ ] Tests/guards added to prevent recurrence.

---

## 5) Required Quarterly Drills

1. Webhook forgery + replay drill.
2. DB latency/failure drill.
3. Deployment rollback drill.
4. Secret-compromise drill.

Each drill must include:
- start/end timestamps
- responders
- failed assumptions
- follow-up hardening tasks
