## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# MemoryNode Alerts

Production alerting mapped 1:1 to the golden metrics in `docs/internal/OBSERVABILITY.md`.

---

## 1) Golden Metric → Alert Mapping

Every golden metric has exactly one alert definition. Alerts reference the structured log fields from OBSERVABILITY.md.

### A. Request-Level Metrics

| ID | Golden Metric | Source filter | Warn threshold | Critical threshold |
| --- | --- | --- | --- | --- |
| A1 | **5xx error rate** | `event_name="request_completed"` AND `status>=500` | >1% over 5 min AND ≥5 events | >3% over 5 min OR ≥20 events |
| A2 | **Auth failure rate** (401/403) | `event_name="request_completed"` AND `status IN (401,403)` | >20% over 10 min AND ≥30 requests | >40% over 10 min AND ≥50 requests |
| A3 | **p95 latency** | `event_name="request_completed"` → `duration_ms` | >1200ms over 10 min | >2500ms over 10 min |

### B. Quota & Rate-Limit Rejections

| ID | Golden Metric | Source filter | Warn threshold | Critical threshold |
| --- | --- | --- | --- | --- |
| B1 | **Cap exceeded (402)** | `event_name="cap_exceeded"` | ≥50 in 5 min | ≥150 in 5 min |
| B2 | **Rate-limit denials (429)** | `request_completed` with `error_code="rate_limited"` | ≥50 in 5 min | ≥150 in 5 min |
| B3 | **Top rejecting projects** | Group B1+B2 by `workspace_id_redacted` | Any single project >30 rejects in 5 min | Any single project >100 rejects in 5 min |

### C. Search & Embed Latency

| ID | Golden Metric | Source filter | Warn threshold | Critical threshold |
| --- | --- | --- | --- | --- |
| C1 | **Embed latency** | `event_name="embed_request"` → `embed_latency_ms` | p95 >2000ms over 10 min | p95 >5000ms over 10 min OR any `success=false` burst ≥5 in 5 min |
| C2 | **Search latency** | `event_name="search_request"` → `search_latency_ms` | p95 >3000ms over 10 min | p95 >8000ms over 10 min |

### D. PayU Webhook Pipeline

| ID | Golden Metric | Source filter | Warn threshold | Critical threshold |
| --- | --- | --- | --- | --- |
| D1 | **Webhook failures** | `event_name IN ("webhook_failed","billing_endpoint_error")` | ≥5 in 10 min | ≥20 in 10 min |
| D2 | **Signature invalid** | `event_name="billing_webhook_signature_invalid"` | ≥1 in 10 min | ≥5 in 10 min |
| D3 | **Project mapping not found** | `event_name="billing_webhook_workspace_not_found"` | >=3 in 10 min | >=10 in 10 min |
| D4 | **Deferred backlog** | `event_name="webhook_deferred"` count − `event_name="webhook_reconciled"` count | ≥5 net deferred in 1 hour | ≥15 net deferred in 1 hour |

### E. DB Latency & RPC Failures

| ID | Golden Metric | Source filter | Warn threshold | Critical threshold |
| --- | --- | --- | --- | --- |
| E1 | **DB RPC latency** | `event_name="db_rpc"` → `db_latency_ms` | p95 >500ms over 10 min | p95 >1500ms over 10 min |
| E2 | **DB RPC failures** | `event_name="db_rpc"` with `success=false` OR `request_completed.error_code="DB_ERROR"` | ≥5 in 10 min | ≥20 in 10 min |

---

## 2) Triage Playbooks

Each alert ID maps to a first-action triage step.

| Alert ID | First action |
| --- | --- |
| **A1** (5xx spike) | Check latest deploy; inspect `error_code` on failing requests; run `pnpm release:staging:validate` against affected env. |
| **A2** (auth spike) | Validate `MASTER_ADMIN_TOKEN` and API key/salt state; check if keys were recently rotated. |
| **A3** (latency) | Inspect route-level distribution (`route_group`, `method`); check Supabase status, OpenAI API status, and embed latency (C1). |
| **B1/B2** (rejections) | Investigate abuse patterns; confirm `RATE_LIMIT_DO` health; tune limits if needed; check if plan caps need adjustment. |
| **B3** (hot project) | Contact project owner if legitimate; consider temporary block if abuse. |
| **C1** (embed slow) | Check OpenAI status page; verify `OPENAI_API_KEY` is valid; consider fallback or queue. |
| **C2** (search slow) | Decompose: is it embed latency (C1) or DB latency (E1)? Fix the bottleneck. |
| **D1** (webhook fail) | Verify `PAYU_MERCHANT_KEY`/`PAYU_MERCHANT_SALT` + endpoint; check `docs/internal/BILLING_RUNBOOK.md` for replay. |
| **D2** (sig invalid) | Possible secret rotation needed or replay attack; verify PayU dashboard webhook config. See `docs/SECURITY.md`. |
| **D3** (project mapping not found) | Check project provisioning pipeline; may need manual workspace mapping reconciliation. |
| **D4** (deferred backlog) | Run `POST /admin/webhooks/reprocess` to drain deferred queue; investigate root cause of missing project mappings. |
| **E1** (DB slow) | Check Supabase dashboard for query performance; verify connection pool; check for index drift. |
| **E2** (DB errors) | Validate Supabase status/credentials; run `pnpm db:verify-rls`, `pnpm db:drift:test`. |

---

## 3) Cloudflare Alert Setup

1. Open **Cloudflare Dashboard** → Workers & Pages → API Worker → Logs.
2. Create saved log views for each alert source filter (column 3 in the tables above).
3. Configure **Logpush** to your alerting destination (Datadog, PagerDuty, Grafana OnCall, etc.).
4. Route alerts to on-call with two severities:
   - **warning**: triage during business hours.
   - **critical**: page immediately.
5. If native log alerting is not yet configured, run a lightweight scheduled check that queries logs and posts to on-call channels.

**Machine-readable rules:** `docs/observability/alert_rules.json` — use for automated alert config or CI validation.

### 3.1 Alert Staging Test (Phase 3)

Before production, verify alerts fire when thresholds are breached:

1. **Staging traffic:** Generate traffic against staging API (e.g. `pnpm smoke:staging` or load test).
2. **Inject failure:** Trigger a 5xx (e.g. invalid config) or latency spike; confirm A1 or A3 fires.
3. **Validate destination:** Ensure alert reaches on-call channel (Slack, PagerDuty, etc.).
4. **Triage runthrough:** Follow this document §2 for the fired alert; confirm playbook is actionable.

Document test results in runbook or TRUST_CHANGELOG.

---

## 4) Health View Cross-Reference

Each alert maps to the health checklist in `docs/internal/OBSERVABILITY.md` §3:

| Health check # | Alert IDs |
| --- | --- |
| 1 (API responding) | A1 |
| 2 (No 5xx spike) | A1 |
| 3 (Auth working) | A2 |
| 4 (Latency OK) | A3 |
| 5 (Rate limits normal) | B1, B2, B3 |
| 6 (Embeds fast) | C1 |
| 7 (Search fast) | C2 |
| 8 (DB healthy) | E1, E2 |
| 9 (Webhooks flowing) | D1 |
| 10 (No webhook backlog) | D4 |
| 11 (No signature issues) | D2 |

---

## 5) Related Runbooks

- Billing ops, replay, reconciliation: `docs/internal/BILLING_RUNBOOK.md`
- Ops secrets + rollback: `docs/OPERATIONS.md`
- Security + rotation: `docs/SECURITY.md`
- Production deploy: `docs/internal/README.md` § Production deploy notes
- Release runbook: `docs/internal/RELEASE_RUNBOOK.md`
