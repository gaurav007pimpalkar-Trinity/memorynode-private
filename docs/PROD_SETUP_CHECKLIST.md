# Production setup checklist

Bring-up steps for the MemoryNode production stack: one Cloudflare Worker, two Cloudflare Pages projects, one Supabase project. Every secret name and binding below is anchored in code; verify against [apps/api/src/env.ts](../apps/api/src/env.ts) and [`.github/workflows/release_production.yml`](../.github/workflows/release_production.yml) before deploying.

## 1. Production topology

| Component | Name | Source |
| --- | --- | --- |
| Worker | `memorynode-api` | [apps/api](../apps/api/) |
| Pages: console | `memorynode-console` | [apps/dashboard](../apps/dashboard/) (`VITE_APP_SURFACE=console`) |
| Pages: app | `memorynode-app` | [apps/dashboard](../apps/dashboard/) (`VITE_APP_SURFACE=app`) |
| Postgres | Supabase (pgvector) | `infra/sql/*.sql` |
| Cron | GitHub Actions (`memory-hygiene.yml` etc.) | no Cloudflare Cron Triggers |

Production domains:

- `api.memorynode.ai` → `memorynode-api` Worker
- `mcp.memorynode.ai` → same Worker, hosted MCP route
- `console.memorynode.ai` → `memorynode-console` Pages
- `app.memorynode.ai` → `memorynode-app` Pages

## 2. Pre-flight

- [ ] Supabase project exists; all migrations in `infra/sql/` applied in order. Confirm with `pnpm migrations:check`.
- [ ] `pgvector` extension enabled; `memories.embedding` and `memory_chunks.embedding` are `vector(1536)`.
- [ ] `wrangler` installed locally and authenticated (`wrangler whoami`).
- [ ] Cloudflare Pages projects `memorynode-console` and `memorynode-app` created.
- [ ] DNS A/AAAA or CNAME records point to the Worker and Pages projects.

## 3. Worker secrets (set with `wrangler secret put`)

Baseline — required at runtime ([apps/api/src/env.ts:137-188](../apps/api/src/env.ts)):

- [ ] `SUPABASE_URL`
- [ ] `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `SUPABASE_ANON_KEY` (required for dashboard session + `rls-first`)
- [ ] `SUPABASE_JWT_SECRET` (required when `SUPABASE_ACCESS_MODE=rls-first` or `REQUEST_SCOPED_DB_ENABLED=1`)
- [ ] `OPENAI_API_KEY` (when `EMBEDDINGS_MODE=openai`, which is the only production mode)
- [ ] `API_KEY_SALT` (≥ 16 chars, random)
- [ ] `MASTER_ADMIN_TOKEN` (≥ 24 chars, random)
- [ ] `AI_COST_BUDGET_INR` (required in prod; `> 0`)

PayU billing — all three required:

- [ ] `PAYU_MERCHANT_KEY`
- [ ] `PAYU_MERCHANT_SALT`
- [ ] `PAYU_WEBHOOK_SECRET`

PayU plan amounts (any non-zero amount must match `packages/shared/src/plans.ts`):

- [ ] `PAYU_LAUNCH_AMOUNT`
- [ ] `PAYU_BUILD_AMOUNT`
- [ ] `PAYU_DEPLOY_AMOUNT`
- [ ] `PAYU_SCALE_AMOUNT`

Optional:

- [ ] `PAYU_PRO_AMOUNT` (legacy; keep set if any workspace still holds the `scale_plus` plan)
- [ ] `PAYU_PRODUCT_INFO`, `PAYU_SUCCESS_PATH`, `PAYU_CANCEL_PATH`, `PAYU_CURRENCY`, `PAYU_BASE_URL`, `PAYU_VERIFY_URL`, `PAYU_VERIFY_TIMEOUT_MS`

Hosted MCP + memory webhook:

- [ ] `MCP_INTERNAL_SECRET` (≥ 32 hex chars, rotated independently)
- [ ] `MEMORY_WEBHOOK_INTERNAL_TOKEN`

Admin hardening (recommended):

- [ ] `ADMIN_AUTH_MODE=signed-required`
- [ ] `ADMIN_ALLOWED_IPS` (comma-separated bastion/CI egress IPs)
- [ ] `ADMIN_BREAK_GLASS=0`

Operational tuning (non-secret `vars` in `wrangler.toml` unless noted):

- [ ] `ENVIRONMENT=prod`
- [ ] `BUILD_VERSION` and `GIT_SHA` (injected by deploy scripts / CI)
- [ ] `EMBEDDINGS_MODE=openai`, `EMBEDDING_MODEL=text-embedding-3-small` (or `-large`; Worker will send `dimensions=1536`)
- [ ] `SUPABASE_ACCESS_MODE=rpc-first` (Phase A) or `rls-first` (Phase B, see [LEAST_PRIVILEGE_ROADMAP.md](./internal/LEAST_PRIVILEGE_ROADMAP.md))
- [ ] `RATE_LIMIT_MODE=on` (off is forbidden in prod by `validateRateLimitConfig`)
- [ ] `WORKSPACE_CONCURRENCY_MAX=8`, `WORKSPACE_CONCURRENCY_TTL_MS=30000`
- [ ] `ALLOWED_ORIGINS=https://console.memorynode.ai,https://app.memorynode.ai`
- [ ] `PUBLIC_APP_URL=https://app.memorynode.ai`
- [ ] `MEMORYNODE_REST_ORIGIN=https://api.memorynode.ai`
- [ ] `AUDIT_IP_SALT` (random; rotated on incident)

Run `CHECK_ENV=prod pnpm check:config` before the first deploy. It enforces `validateSecrets` and `validateStubModes` in [apps/api/src/env.ts](../apps/api/src/env.ts).

## 4. Durable Object bindings

In `wrangler.toml`, under the `memorynode-api` Worker:

- `RATE_LIMIT_DO` → `class_name = "RateLimitDO"`, migration tag `v1`.
- `CIRCUIT_BREAKER_DO` → `class_name = "CircuitBreakerDO"`, migration tag `v2`.

Apply both DO migrations during the first `wrangler deploy`.

## 5. First deploy

1. `pnpm install --frozen-lockfile`
2. `CHECK_ENV=prod pnpm check:config`
3. `pnpm test`
4. `pnpm build`
5. `pnpm openapi:check` (drift gate)
6. `pnpm deploy:staging` → run `pnpm release:staging:validate`.
7. `pnpm deploy:prod` (or merge to `main` for staging auto-deploy, then **Release Production** with the SHA) → run `pnpm release:prod:validate`.

## 6. Post-deploy verification

- [ ] `GET https://api.memorynode.ai/healthz` returns 200 with `version`, `embedding_model`, and `rate_limit_mode: "on"`.
- [ ] `GET https://api.memorynode.ai/ready` returns 200 (Supabase reachable).
- [ ] Hosted MCP `POST https://mcp.memorynode.ai/mcp` with a valid API key returns a JSON-RPC `initialize` result.
- [ ] Console and app surfaces load; `POST /v1/dashboard/session` issues a cookie + CSRF token after Supabase login.
- [ ] Run a `/v1/memories` create + `/v1/search` cycle with a freshly issued API key.
- [ ] `POST /v1/billing/checkout` returns a valid PayU form URL; `POST /v1/billing/portal` returns 410.

## 7. PayU dashboard

- [ ] Webhook URL set to `https://api.memorynode.ai/v1/billing/webhook`.
- [ ] Webhook signing secret matches `PAYU_WEBHOOK_SECRET`.
- [ ] Merchant salt matches `PAYU_MERCHANT_SALT`.
- [ ] Verify API access enabled (required by `verifyPayUTransactionViaApi`).

## 8. Ongoing

- `pnpm migrations:check` must stay green (tokens live in [docs/internal/README.md](./internal/README.md)).
- `pnpm check:docs-drift`, `pnpm openapi:check`, `pnpm check:docs-billing`, `pnpm check:runbooks`, `pnpm check:observability-contracts`, `pnpm check:least-privilege` all run in CI.
- Schedule the GitHub Actions workflows for memory hygiene and retention (`memory-hygiene.yml`, `memory-retention.yml`). Cloudflare Cron Triggers are intentionally not used.
