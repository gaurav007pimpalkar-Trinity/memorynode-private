# Production Deploy Notes (Cloudflare Workers)

## Vars vs Secrets
- Safe `[vars]` (checked into `apps/api/wrangler.toml`): `SUPABASE_URL`, `SUPABASE_MODE`, `EMBEDDINGS_MODE`, `ENVIRONMENT`, `RATE_LIMIT_MODE`, `ALLOWED_ORIGINS`, `PUBLIC_APP_URL`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`, optional `STRIPE_PORTAL_CONFIGURATION_ID`, `STRIPE_SUCCESS_PATH`, `STRIPE_CANCEL_PATH`.
- Secrets (set with `wrangler secret put NAME` in Cloudflare, never in `[vars]`): `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- Reason: Cloudflare overwrites dashboard secrets with values from `[vars]` on deploy. Keeping secrets out of `[vars]` preserves existing secret values.

## Required bindings
- Durable Object binding for rate limit:
  ```
  [durable_objects]
  bindings = [{ name = "RATE_LIMIT_DO", class_name = "RateLimitDO" }]

  [[migrations]]
  tag = "v1"
  new_classes = ["RateLimitDO"]
  ```

## Validation & guardrails
- Runtime: startup checks fail with `CONFIG_ERROR` if secrets are missing in prod/staging (message tells you to run `wrangler secret put ...`).
- Static: `pnpm check:wrangler` blocks commits if forbidden secrets appear under `[vars]` in `apps/api/wrangler.toml`.

## Deploy steps (prod/staging)
1) Run `pnpm check:wrangler && pnpm typecheck && pnpm test`.
2) Set/update secrets: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (repeat for others).
3) Verify `[vars]` only contains safe values; ensure `ENVIRONMENT=prod` (or `staging`), `SUPABASE_MODE` not `stub`, `EMBEDDINGS_MODE=openai`.
4) Deploy: `cd apps/api && wrangler deploy`.
5) Post-deploy: verify `/healthz`, `/v1/memories`, `/v1/search`, `/v1/billing/status`.
