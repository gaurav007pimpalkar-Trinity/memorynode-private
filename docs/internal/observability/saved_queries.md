# MemoryNode — Saved Log Queries (§3.1)

Every signal in Phase 3 §3.1 is queryable via these definitions. Use with **Cloudflare Logpush** → your log sink (Datadog, Grafana Cloud, Splunk, etc.) or **Cloudflare Workers Logs** UI.

**Goal:** Answer any signal in <5 minutes.

---

## A. API Signals

### A1. p95 / p99 latency per route (successful 2xx/3xx)

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `api_latency_p95_per_route` | `event_name="request_completed"` AND `status>=200` AND `status<400` | `percentile(duration_ms, 95)` by `route_group`, `method` |
| `api_latency_p99_per_route` | `event_name="request_completed"` AND `status>=200` AND `status<400` | `percentile(duration_ms, 99)` by `route_group`, `method` |

**CWL-style filter:**
```
fields @timestamp, @message
| filter event_name = "request_completed" and status >= 200 and status < 400
| stats percentile(duration_ms, 95) as p95_ms, percentile(duration_ms, 99) as p99_ms by route_group, method
```

### A2. p99 latency for 5xx ("time to fail") — health view only

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `api_5xx_latency_p99` | `event_name="request_completed"` AND `status>=500` | `percentile(duration_ms, 99)` by `route_group` |

**CWL-style filter:**
```
fields @timestamp, @message
| filter event_name = "request_completed" and status >= 500
| stats percentile(duration_ms, 99) as p99_fail_ms by route_group
```

### A3. 5xx rate per route

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `api_5xx_rate` | `event_name="request_completed"` AND `status>=500` | `count()` by `route_group` over 5 min |
| `api_5xx_rate_pct` | `event_name="request_completed"` | `count(status>=500) / count(*) * 100` by `route_group` |

### A4. 4xx rate (optional)

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `api_4xx_rate` | `event_name="request_completed"` AND `status>=400` AND `status<500` | `count()` by `route_group`, `status` |

### A5. Rate-limit (429) per tenant

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `api_429_per_tenant` | `event_name="request_completed"` AND `error_code="rate_limited"` | `count()` by `workspace_id_redacted` |
| `api_429_total` | `event_name="request_completed"` AND `error_code="rate_limited"` | `count()` |

### A6. Queue / backlog (deferred webhooks)

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `webhook_deferred_count` | `event_name="webhook_deferred"` | `count()` in window |
| `webhook_reconciled_count` | `event_name="webhook_reconciled"` | `count()` in window |
| `deferred_backlog` | See D4 below | `webhook_deferred_count - webhook_reconciled_count` |

### A7. DB query timeouts and vector search p95

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `db_rpc_latency_p95` | `event_name="db_rpc"` | `percentile(db_latency_ms, 95)` by `rpc` |
| `search_latency_p95` | `event_name="search_request"` | `percentile(search_latency_ms, 95)` |

---

## B. Billing (PayU) Signals

### B1. Webhook receive → verify → process timings

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `webhook_verify_latency` | `event_name="webhook_verified"` | `verify_timestamp - receive_timestamp` (if logged); else correlate by `request_id` |
| `webhook_process_latency` | `event_name="webhook_processed"` | `processed_timestamp - verify_timestamp` (correlate by `request_id`) |

**Note:** If timestamps are not in events, use `@timestamp` and correlate `webhook_received` → `webhook_verified` → `webhook_processed` by `request_id`.

### B2. Dedup hit rate

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `webhook_received_count` | `event_name="webhook_received"` | `count()` |
| `webhook_replayed_count` | `event_name="webhook_replayed"` | `count()` |
| `dedup_hit_rate` | — | `webhook_replayed_count / webhook_received_count * 100` |

### B3. Replay success rate

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `webhook_replay_attempts` | Replay/reprocess calls | Track via `webhook_reconciled` or admin reprocess logs |
| `webhook_replay_success` | `event_name="webhook_processed"` where origin=replay | `count()` |

### B4. Failure reasons with counts

| Query name | Filter |
|------------|--------|
| `webhook_failed` | `event_name="webhook_failed"` — group by `error` or `event_type` |
| `signature_invalid` | `event_name="billing_webhook_signature_invalid"` |
| `workspace_not_found` | `event_name="billing_endpoint_error"` or `billing_webhook_workspace_not_found` |

---

## C. Tenancy Signals

### C1. Top N noisy tenants

| Query name | Filter | Aggregation |
|------------|--------|-------------|
| `top_tenants_by_requests` | `event_name="request_completed"` | `count()` by `workspace_id_redacted` — top 10 |
| `top_tenants_by_429` | `event_name="request_completed"` AND `error_code="rate_limited"` | `count()` by `workspace_id_redacted` — top 10 |
| `top_tenants_cap_exceeded` | `event_name="cap_exceeded"` | `count()` by `workspace_id_redacted` |

### C2. Abuse detection

| Query name | Filter | Purpose |
|------------|--------|---------|
| `spike_401_403_per_key` | `event_name="request_completed"` AND `status IN (401, 403)` | Group by `api_key_id` or `workspace_id`; alert if burst |
| `burst_failed_webhooks_per_workspace` | `event_name="webhook_failed"` | Group by `workspace_id`; alert if ≥N in short window |

---

## D. Health View — Single Dashboard Queries

Consolidate into one "Is the API healthy?" view. Use time range: **last 5–10 minutes**.

| # | Check | Query / filter |
|---|-------|----------------|
| 1 | API responding | `event_name="request_completed"` — events in last 5 min |
| 2 | No 5xx spike | `event_name="request_completed"` AND `status>=500` — <1% |
| 3 | Auth working | `event_name="request_completed"` AND `status IN (401,403)` — <20% |
| 4 | Latency OK | `event_name="request_completed"` → p95 < 500ms, p99 < 1500ms |
| 5 | Rate limits | `cap_exceeded` OR `error_code="rate_limited"` — <50 in 5 min |
| 6 | Embeds fast | `event_name="embed_request"` → p95 < 2000ms |
| 7 | Search fast | `event_name="search_request"` → p95 < 3000ms |
| 8 | DB healthy | `event_name="db_rpc"` → p95 < 500ms, no `success=false` burst |
| 9 | Webhooks flowing | `event_name="webhook_processed"` — processing after callbacks |
| 10 | No webhook backlog | `webhook_deferred` − `webhook_reconciled` — <5 in 1h |
| 11 | No signature issues | `event_name="billing_webhook_signature_invalid"` — 0 in 1h |

---

## Export for Datadog / Grafana

If using Datadog Logs or Grafana Loki:

- **Index/facet** on: `event_name`, `route_group`, `status`, `error_code`, `workspace_id_redacted`
- **Saved views:** Create one saved view per query above; name matches query name.
- **Dashboard JSON:** See `docs/observability/health_view_dashboard.json` (if provided) or build from this spec.
