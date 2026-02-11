## Observability + Alertability (Production)

Events emitted as structured JSON (console):
- `event_name="request_completed"` with `workspace_id` (if known), `route`, `method`, `status`, `duration_ms`, `request_id`.
- `request_completed` also carries `error_code` and `error_message` when status is 4xx/5xx.
- `event_name="request_failed"` when a request throws before normal completion. Includes `request_id`, route/method/status, and redacted error stack/message.
- `event_name="webhook_received"` when Stripe webhook request arrives.
- `event_name="webhook_verified"` after signature + timestamp verification succeeds.
- `event_name="webhook_processed"` when webhook side effects are applied (or stale event is ignored).
- `event_name="webhook_replayed"` when duplicate `event_id` is safely ignored.
- `event_name="webhook_deferred"` when workspace mapping is missing and event is parked for retry.
- `event_name="webhook_reconciled"` when canonical Stripe fetch is used to resolve ambiguous ordering.
- `event_name="webhook_failed"` when verification or processing fails.
- `event_name="billing_webhook_signature_invalid"` when Stripe signature validation fails.
- `event_name="billing_webhook_workspace_not_found"` when a webhook customer cannot be mapped to a workspace.
- `event_name="billing_endpoint_error"` when billing status/checkout/portal handlers fail.
- `event_name="cap_exceeded"` when plan limits block a request (includes redacted workspace id and plan status).

What to alert on:
- 5xx error rate above baseline (e.g., >1% over 5 minutes).
- Any sustained increase in `event_name="request_failed"`.
- Spikes in `webhook_failed`, `billing_webhook_signature_invalid`, `billing_webhook_workspace_not_found`, or `billing_endpoint_error`.
- Latency: start with p95 `request_completed.duration_ms` < 500ms for public endpoints.

SLO starter:
- Availability: 99.9% of requests return <500 within 30s rolling window.
- Latency: p95 < 500ms, p99 < 1500ms for authenticated endpoints.

How to consume:
- Forward Cloudflare Worker logs via Logpush → your log sink (e.g., R2 or SIEM).
- Build alerts on the JSON fields above; do not parse bodies or headers.

Cloudflare dashboard quick checks:
- Open Workers & Pages -> your API Worker -> Logs.
- Filter for `event_name="request_completed"` to inspect request health.
- Filter for `status>=500` or `error_code="DB_ERROR"` during incidents.
- Filter by `request_id="<value from client response header>"` to trace a single request end-to-end.
- Filter for `event_name in ("webhook_received","webhook_verified","webhook_processed","webhook_replayed","webhook_failed")` during billing incidents.

## Client behavior for 429/413

- `429` responses use `error.code="rate_limited"` and include `Retry-After` plus `x-request-id`.
- `413` responses use `error.code="payload_too_large"` and include `x-request-id`.
- Client retry guidance:
  - On `429`, respect `Retry-After` first, then exponential backoff with jitter (`250ms`, `500ms`, `1s`, `2s`, ...).
  - On `413`, do not retry unchanged payloads; split/chunk and retry with smaller bodies.
  - Always log `request_id` with UTC timestamp so incidents can be traced from Cloudflare logs.
