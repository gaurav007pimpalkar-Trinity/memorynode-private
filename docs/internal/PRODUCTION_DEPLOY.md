# Production Deploy Notes (Cloudflare Workers)

Canonical deploy/rollback workflow:
- `docs/RELEASE_RUNBOOK.md`
- `docs/PROD_READY.md`

## Vars vs Secrets
- Safe `[vars]` (checked into `apps/api/wrangler.toml`): `SUPABASE_URL`, `SUPABASE_MODE`, `EMBEDDINGS_MODE`, `ENVIRONMENT`, `RATE_LIMIT_MODE`, `ALLOWED_ORIGINS`, `PUBLIC_APP_URL`, `PAYU_BASE_URL`, `PAYU_VERIFY_URL`, optional `PAYU_SUCCESS_PATH`, `PAYU_CANCEL_PATH`, `PAYU_PRO_AMOUNT`, `PAYU_PRODUCT_INFO`, `PAYU_CURRENCY`.
- Secrets (set with `wrangler secret put NAME` in Cloudflare, never in `[vars]`): `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, optional `PAYU_WEBHOOK_SECRET`.
- Reason: Cloudflare overwrites dashboard secrets with values from `[vars]` on deploy. Keeping secrets out of `[vars]` preserves existing secret values.

## Required bindings
- Durable Object binding for rate limit:
  ```
  [durable_objects]
  bindings = [{ name = "RATE_LIMIT_DO", class_name = "RateLimitDO" }]

  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["RateLimitDO"]
  ```

## Validation & guardrails
- Runtime: startup checks fail with `CONFIG_ERROR` if secrets are missing in prod/staging (message tells you to run `wrangler secret put ...`).
- Static: `pnpm check:wrangler` blocks commits if secret-like values appear in `wrangler.toml` vars blocks (`[vars]` and `[env.<name>.vars]`).

## Deploy steps (prod/staging)
1) Run `pnpm check:wrangler && pnpm typecheck && pnpm test`.
2) Set/update secrets: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (repeat for others).
3) Verify `[vars]` only contains safe values; ensure `ENVIRONMENT=production` (or `staging`), `SUPABASE_MODE` not `stub`, `EMBEDDINGS_MODE=openai`.
4) Deploy with repo scripts (no global wrangler dependency):
   - Staging: `pnpm --filter @memorynode/api deploy:staging`
   - Production: `pnpm --filter @memorynode/api deploy:production`
5) Post-deploy: verify `/healthz`, `/v1/memories`, `/v1/search`, `/v1/billing/status`.
