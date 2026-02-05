# Performance Baseline (k6)

## How to run
Requires k6 locally and a staging base URL:
```
BASE_URL=https://api-staging.memorynode.ai \
MEMORYNODE_API_KEY=mn_live_xxx \
k6 run scripts/perf_k6.js
```

Endpoints exercised:
- POST `/v1/memories` (ingest small memory)
- POST `/v1/search`
- POST `/v1/context`

The k6 script uses small payloads and default options (`vus:5`, `duration:30s`, p95<800ms threshold).

## Starter SLO targets (edit as we learn)
- Availability: error rate <1% over 5-minute windows.
- Latency:
  - p95 search/context < 800ms
  - p99 search/context < 1500ms
- Ingest p95 < 800ms.

## If latency is high
- Check payload sizes (truncate text, chunking).
- Verify embeddings/indexing jobs are healthy.
- Enable/adjust caching if safe.
- Confirm rate limiting not throttling legitimate traffic.
- Inspect DB load and query plans; add indexes for hot filters.

## If error rate is high
- Examine structured logs (`http_request`, `stripe_webhook_error`).
- Verify secrets/config (`pnpm check:config` with CHECK_ENV=production).
- Ensure rate limit DO binding and Supabase connectivity.
