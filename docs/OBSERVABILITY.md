## Observability + Alertability (Production)

Events emitted as structured JSON (console):
- `event_name="request_summary"` with `workspace_id` (if known), `route`, `method`, `status`, `duration_ms`, `request_id`.
- `request_summary` also carries `error_code` and `error_message` when status is 4xx/5xx.
- `event_name="billing_webhook_signature_invalid"` when Stripe signature validation fails.
- `event_name="billing_webhook_workspace_not_found"` when a webhook customer cannot be mapped to a workspace.
- `event_name="billing_endpoint_error"` when billing status/checkout/portal handlers fail.
- `event_name="cap_exceeded"` when plan limits block a request (includes redacted workspace id and plan status).

What to alert on:
- 5xx error rate above baseline (e.g., >1% over 5 minutes).
- Spikes in `billing_webhook_signature_invalid`, `billing_webhook_workspace_not_found`, or `billing_endpoint_error`.
- Latency: start with p95 `request_summary.duration_ms` < 500ms for public endpoints.

SLO starter:
- Availability: 99.9% of requests return <500 within 30s rolling window.
- Latency: p95 < 500ms, p99 < 1500ms for authenticated endpoints.

How to consume:
- Forward Cloudflare Worker logs via Logpush → your log sink (e.g., R2 or SIEM).
- Build alerts on the JSON fields above; do not parse bodies or headers.

Cloudflare dashboard quick checks:
- Open Workers & Pages -> your API Worker -> Logs.
- Filter for `event_name="request_summary"` to inspect request health.
- Filter for `status>=500` or `error_code="DB_ERROR"` during incidents.
- Filter for `event_name="billing_webhook_signature_invalid"` when validating Stripe webhook setup.
