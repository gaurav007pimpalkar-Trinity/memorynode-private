# Alerts

Human-facing description of the alerts defined in [docs/observability/alert_rules.json](../observability/alert_rules.json) and the SLOs in [slo_targets.json](../observability/slo_targets.json). Each alert is grounded in events the `memorynode-api` Worker actually emits; see [OBSERVABILITY.md](./OBSERVABILITY.md) for the event schema.

Category letters map to [INCIDENT_RUNBOOKS.md](./INCIDENT_RUNBOOKS.md) playbooks.

## Category A — API health

### A1 — 5xx error rate

- Source: `request_completed` logs with `status >= 500`.
- Warn: `rate_pct > 1` over 5 min, `min_events: 5`.
- Critical: `rate_pct > 3` OR `count >= 20` over 5 min.
- Runbook: [INCIDENT_RUNBOOKS.md §3.5](./INCIDENT_RUNBOOKS.md).

### A2 — Auth failure rate (401/403)

- Source: `request_completed` with `status IN (401, 403)`.
- Warn: `rate_pct > 20` over 10 min, `min_requests: 30`.
- Critical: `rate_pct > 40` over 10 min, `min_requests: 50`.
- Runbook: [§3.1 Auth outage / auth failure spike](./INCIDENT_RUNBOOKS.md).

### A3 — p95 latency

- Source: `request_completed.duration_ms` (all routes).
- Warn: p95 > 1200 ms over 10 min.
- Critical: p95 > 2500 ms over 10 min.
- Runbook: §3.2 DB degradation or §3.5 release regression.

## Category B — Quota and rate-limit

### B1 — Cap exceeded (402)

- Source: `cap_exceeded` log events emitted by quota reservation.
- Warn: 50 events over 5 min.
- Critical: 150 events over 5 min.

### B2 — Rate-limit denials (429)

- Source: `request_completed` with `error_code == "rate_limited"`.
- Warn: 50 events over 5 min; Critical: 150 events over 5 min.
- Runbook: [§3.4 Rate-limit infrastructure outage / abuse spike](./INCIDENT_RUNBOOKS.md).

### B3 — Top rejecting workspaces

- Source: union of `cap_exceeded` and `request_completed` with `error_code == "rate_limited"`, grouped by `workspace_id_redacted`.
- Warn: 30 per workspace over 5 min; Critical: 100 per workspace over 5 min.

## Category C — External AI calls

### C1 — Embed latency

- Source: `embed_request` logs.
- Warn: p95 `embed_latency_ms` > 2000 ms.
- Critical: p95 > 5000 ms, or `success=false` burst of 5+ in 5 min.

### C2 — Search latency

- Source: `search_request` logs.
- Warn: p95 `search_latency_ms` > 3000 ms.
- Critical: p95 > 8000 ms.

Both are paired with circuit-breaker state (see [circuitBreakerDo.ts](../../apps/api/src/circuitBreakerDo.ts)).

## Category D — Billing webhooks (PayU)

### D1 — Webhook failures

- Source: `webhook_failed` or `billing_endpoint_error`.
- Warn: 5 events in 10 min; Critical: 20 in 10 min.

### D2 — Signature invalid

- Source: `billing_webhook_signature_invalid`.
- Warn: 1 event in 10 min; Critical: 5 events in 10 min.
- Runbook: [§3.3 Billing webhook forgery/replay/surge](./INCIDENT_RUNBOOKS.md).

### D3 — Workspace not found

- Source: `billing_webhook_workspace_not_found`.
- Warn: 3 events in 10 min; Critical: 10 events in 10 min.

### D4 — Deferred backlog

- Source: `webhook_deferred` minus `webhook_reconciled`.
- Warn: net backlog ≥ 5 over 60 min; Critical: ≥ 15.
- Mitigation: `POST /admin/webhooks/reprocess`.

## Category E — Database

### E1 — DB RPC latency

- Source: `db_rpc` logs.
- Warn: p95 `db_latency_ms` > 500 ms over 10 min.
- Critical: p95 > 1500 ms over 10 min.

### E2 — DB RPC failures

- Source: `db_rpc` with `success=false`, or `request_completed` with `error_code=="DB_ERROR"`.
- Warn: 5 in 10 min; Critical: 20 in 10 min.
- Runbook: [§3.2 DB degradation / RPC failures](./INCIDENT_RUNBOOKS.md).

## SLOs

Defined in [slo_targets.json](../observability/slo_targets.json); derived targets cite [resilienceConstants.ts](../../apps/api/src/resilienceConstants.ts) via the `_source` field on each target.

| Service | Target | Rationale |
| --- | --- | --- |
| `api` | 99.9% availability, p99 < 2000 ms | Aligns with A1/A3 criticals. |
| `billing_webhook` | 99% processed within 300 s | PayU retries; D4 backlog alert triggers before SLO burn. |
| `dashboard_session` | 99.9% availability, p99 < 1000 ms | Interactive UI path. |

Paging policy:

- Critical: 5 min ack, 30 min mitigate.
- Warning: 30 min ack, 240 min mitigate.

## Where the raw data lives

- Cloudflare Workers Logpush (tail) → your log store of choice.
- `api_audit_log` table in Supabase (per-workspace audit trail).
- `founder_phase1_request_events` table for long-horizon analytics.
