## Observability + Alertability (Production)

Events emitted as structured JSON (console):
- `event="http_request"` with method, path, status, duration_ms, stage, request_id.
- `event="stripe_webhook_sig_fail"` when Stripe signature validation fails.
- `event="stripe_webhook_error"` when webhook processing errors.
- `event="stripe_webhook_ok"` on successful webhook handling.

What to alert on:
- 5xx error rate above baseline (e.g., >1% over 5 minutes).
- Spikes in `stripe_webhook_error` or `stripe_webhook_sig_fail`.
- Latency: start with p95 `http_request.duration_ms` < 500ms for public endpoints.

SLO starter:
- Availability: 99.9% of requests return <500 within 30s rolling window.
- Latency: p95 < 500ms, p99 < 1500ms for authenticated endpoints.

How to consume:
- Forward Cloudflare Worker logs via Logpush → your log sink (e.g., R2 or SIEM).
- Build alerts on the JSON fields above; do not parse bodies or headers.
