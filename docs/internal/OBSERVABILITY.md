# Observability

How to read MemoryNode signals. Everything below is emitted directly by the `memorynode-api` Worker or written to Supabase by the handlers themselves. There is no external APM agent.

## 1. Signal surface

| Signal | Where | Source |
| --- | --- | --- |
| Structured logs (JSON per line) | Cloudflare Worker stdout → Logpush | [apps/api/src/logger.ts](../../apps/api/src/logger.ts) |
| `api_audit_log` rows | Supabase table | `emitAuditLog` in [apps/api/src/audit.ts](../../apps/api/src/audit.ts) |
| `founder_phase1_request_events` rows | Supabase table | `persistApiRequestEvent` ([apps/api/src/workerApp.ts](../../apps/api/src/workerApp.ts)) |
| `api_requests_daily` / `usage_events` | Supabase tables | Billing + usage handlers |
| Health probes | `/healthz`, `/ready`, `/v1/health` | `workerApp.ts` |

## 2. `request_completed`

Every request that leaves the Worker emits one `request_completed` log line from `workerApp.ts:1127-1140`:

```json
{
  "event": "request_completed",
  "request_id": "01HX...",
  "workspace_id": "<uuid or null>",
  "route": "/v1/search",
  "route_group": "search",
  "method": "POST",
  "status": 200,
  "status_code": 200,
  "latency_ms": 143,
  "duration_ms": 143,
  "error_code": null,
  "error_type": null
}
```

`route_group` values come from `classifyRouteGroup` in [workerApp.ts:1161-1195](../../apps/api/src/workerApp.ts): `health`, `memories`, `search`, `evals`, `context`, `pruning`, `explain`, `usage`, `dashboard`, `billing`, `workspaces`, `api_keys`, `import`, `connectors`, `mcp`, `admin`, `unknown`.

## 3. Other emitted events

| Event | Where | Purpose |
| --- | --- | --- |
| `embed_request` | OpenAI embed wrapper | p95 latency, retries (alert **C1**) |
| `search_request` | `/v1/search` | p95 latency (alert **C2**) |
| `db_rpc` | Supabase helper | Latency + success (alerts **E1/E2**) |
| `cap_exceeded` | Quota reservation | 402 responses (alert **B1**) |
| `webhook_deferred`, `webhook_reconciled` | PayU webhook handler | Backlog (alert **D4**) |
| `webhook_failed`, `billing_endpoint_error` | PayU webhook handler | D1 |
| `billing_webhook_signature_invalid` | PayU signature verify | D2 |
| `billing_webhook_workspace_not_found` | PayU webhook handler | D3 |
| `rate_limit_do_unavailable`, `rate_limit_binding_missing` | Rate-limit pipeline | Infra guard |
| `mcp_policy_before`, `mcp_policy_after`, `mcp_tool_execution` | Hosted MCP | Policy visibility |
| `db_access_path_selected` | DB client factory | `service-role` vs `rpc-first` vs `rls-first` observability |

All events include `request_id` when applicable.

## 4. `api_audit_log`

Inserted by `emitAuditLog` ([apps/api/src/audit.ts](../../apps/api/src/audit.ts)) at the end of every tenant request. Columns include:

- `workspace_id`, `actor_kind` (`api_key`, `dashboard_session`, `admin`, `webhook`)
- `action` (normalized route + method)
- `status_code`, `request_id`, `latency_ms`
- `ip_salted_hash` (SHA-256 of client IP + `AUDIT_IP_SALT`)
- `metadata` JSONB

`GET /v1/audit/log` exposes paginated rows to the owning workspace.

## 5. Health endpoints

| Path | Auth | Behavior |
| --- | --- | --- |
| `/healthz` | Public | Runs `validateSecrets`, `validateStubModes`, `validateRateLimitConfig`. Returns `{ status, version: BUILD_VERSION, git_sha: GIT_SHA, embedding_model, rate_limit_mode }`. 200 on success; 503 if a guard fails. |
| `/ready` | Public | Calls the `get_api_key_salt` RPC through the Supabase circuit breaker. 200 if DB is reachable. |
| `/v1/health` | Public | Same payload as `/healthz`. |

## 6. Resilience constants

Table aligned to [apps/api/src/resilienceConstants.ts](../../apps/api/src/resilienceConstants.ts). Alert thresholds in [docs/observability/slo_targets.json](../observability/slo_targets.json) are derived from these.

| Constant | Value | Meaning |
| --- | --- | --- |
| `EMBED_REQUEST_TIMEOUT_MS` | 15000 | OpenAI embed per-call timeout |
| `EXTRACT_REQUEST_TIMEOUT_MS` | 20000 | Extraction LLM timeout |
| `PAYU_VERIFY_TIMEOUT_MS` | 10000 | PayU verify API timeout |
| `SUPABASE_RETRY_DELAYS_MS` | [200, 500, 1200] | Supabase RPC retry schedule |
| `WORKSPACE_CONCURRENCY_MAX` | 8 | In-flight quota-consuming requests per workspace |
| `RATE_LIMIT_MAX` | 60 | Default per-key RPM |
| `WORKSPACE_RPM_DEFAULT` | 120 | Workspace-level RPM |

Circuit breakers are implemented in [apps/api/src/circuitBreakerDo.ts](../../apps/api/src/circuitBreakerDo.ts) (Durable Object) with a per-isolate in-memory fallback.

## 7. Wiring alerts

- Rules: [docs/observability/alert_rules.json](../observability/alert_rules.json) (A1–A3, B1–B3, C1–C2, D1–D4, E1–E2).
- Human description: [ALERTS.md](./ALERTS.md).
- Response: [INCIDENT_RUNBOOKS.md](./INCIDENT_RUNBOOKS.md).

Point your log drain (Cloudflare Logpush or equivalent) at the `request_completed` stream plus the other event names in §3, and translate each alert rule into a query on the live log index.

## 8. Correlating

Every response carries `x-request-id`. Given a customer report with that id:

1. Find `request_completed` with matching `request_id` → `status`, `latency_ms`, `error_code`.
2. Join `api_audit_log` on `request_id` → full actor context.
3. If the request is a billing webhook, join `payu_webhook_events` on `request_id`.
