# Health View — "Is the API Healthy?" (<2 min)

Single dashboard for on-call. Open this view in **<2 minutes** to assess production health.

---

## Quick Access

- **Direct URL:** Your log sink dashboard filtered to the queries below (e.g. Grafana "API Health" dashboard, Datadog "MemoryNode Health").
- **Cloudflare:** Workers & Pages → memorynode-api → Logs → use saved filters from `docs/observability/saved_queries.md`.
- **Healthz:** `curl -s https://api.memorynode.ai/healthz | jq .`

---

## Health Checks (Run in Order)

| # | Check | Filter / Query | Healthy When |
|---|-------|----------------|--------------|
| 1 | API responding | `event_name="request_completed"` | Events flowing in last 5 min |
| 2 | No 5xx spike | `status>=500` on `request_completed` | <1% of requests over 5 min |
| 3 | Auth working | `status IN (401,403)` | <20% over 10 min |
| 4 | Latency OK | `duration_ms` from `request_completed` | p95 < 500ms, p99 < 1500ms |
| 5 | Rate limits normal | `cap_exceeded` OR `error_code="rate_limited"` | <50 events in 5 min |
| 6 | Embeds fast | `embed_request` → `embed_latency_ms` | p95 < 2000ms |
| 7 | Search fast | `search_request` → `search_latency_ms` | p95 < 3000ms |
| 8 | DB healthy | `db_rpc` → `db_latency_ms` | p95 < 500ms, no `success=false` burst |
| 9 | Webhooks flowing | `event_name="webhook_processed"` | Processing after each PayU callback |
| 10 | No webhook backlog | `webhook_deferred` − `webhook_reconciled` | <5 net deferred in 1h |
| 11 | No signature issues | `billing_webhook_signature_invalid` | 0 in last hour |

**Paging thresholds:** See `docs/ALERTS.md` (A1–E2).

---

## If Any Check is RED

1. See `docs/ALERTS.md` §2 (Triage Playbooks) for first action.
2. Use `x-request-id` from client → filter logs by `request_id`.
3. Check `docs/OPERATIONS.md` for rollback and incident procedures.
4. For billing: `docs/BILLING_RUNBOOK.md`.

---

## Dashboard Definition (Grafana-style)

Create one dashboard with 3 rows:

1. **Row 1 — Request health:** Request rate, 5xx rate %, p95/p99 latency (time series).
2. **Row 2 — Search & DB:** Embed p95, search p95, db_rpc p95, db success rate.
3. **Row 3 — Webhooks:** webhook_processed rate, deferred backlog, failure counts.

All queries reference `docs/observability/saved_queries.md`.
