# MemoryNode Launch Checklist

Use this every time we go live (or reconfigure) to avoid surprises. Keep it short, copy-pasteable, and forward-only for the DB.

## 1) Pre-launch basics
- Wrangler config hygiene:
  - `[vars]` may include only non-secret values: `SUPABASE_URL`, `SUPABASE_MODE`, `EMBEDDINGS_MODE`, `ENVIRONMENT`, `RATE_LIMIT_MODE`, `ALLOWED_ORIGINS`, `PUBLIC_APP_URL`, Stripe price ids/paths.
  - Secrets must be set with `wrangler secret put ...` (never in `[vars]`): `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
  - Why: putting secrets in `[vars]` wipes Cloudflare dashboard secrets on deploy. Keep secrets only in secret storage.
- Required runtime config (Cloudflare dashboard): all secrets above + `RATE_LIMIT_DO` binding + `SUPABASE_URL`, `SUPABASE_MODE`, `EMBEDDINGS_MODE`, `ENVIRONMENT`, `RATE_LIMIT_MODE`, `ALLOWED_ORIGINS`, `PUBLIC_APP_URL`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`, optional `STRIPE_PORTAL_CONFIGURATION_ID`, `STRIPE_SUCCESS_PATH`, `STRIPE_CANCEL_PATH`. **Prod must NOT use stub modes**: set `SUPABASE_MODE` to real DB (not `stub`) and `EMBEDDINGS_MODE=openai`.
- Rate limit Durable Object setup:
  - Ensure `apps/api/wrangler.toml` contains:
    ```
    [durable_objects]
    bindings = [
      { name = "RATE_LIMIT_DO", class_name = "RateLimitDO" }
    ]

    [[migrations]]
    tag = "v1"
    new_classes = ["RateLimitDO"]
    ```
  - Do not set `RATE_LIMIT_MODE=off` in production; allowed only for dev/staging.
- Tooling: Corepack enabled and pnpm activated (`corepack enable && corepack prepare pnpm@latest-10 --activate`).
   - If `corepack enable` fails on Windows (EPERM), skip it and run `corepack prepare pnpm@latest-10 --activate` then invoke `pnpm` (or `pnpm.cjs` if that’s what is present) or add the Corepack pnpm folder to `PATH`.
- Domains: API base URL reachable (e.g., `https://api.memorynode.ai`), DNS propagated.
- CORS: `ALLOWED_ORIGINS` includes dashboard origin; default deny otherwise.
- Dashboard env (`apps/dashboard/.env.local`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL`.

## 2) Database migrations
- Order (forward-only):  
  `001_init.sql` → `002_rpc.sql` → `003_usage_rpc.sql` → `004_workspace_plan.sql` → `005_api_audit_log.sql` → `006_rls.sql` → `007_current_workspace_patch.sql` → `008_membership_rls.sql` → `009_workspace_rpc.sql` → `010_api_keys_mask.sql` → `011_api_key_rpcs.sql` → `012_billing.sql` → `013_events.sql` → `014_activation.sql` → `015_invites.sql` → `016_webhook_events.sql`
- Apply: run in Supabase SQL editor (or psql) in order.
- Verify: `select relrowsecurity from pg_class where relname in ('memories','api_keys','workspaces');` (expect `t`), plus `select count(*) from workspaces;` to ensure data intact.

## 3) Stripe setup
- Test mode checklist:
  - Create `STRIPE_PRICE_PRO` and `STRIPE_PRICE_TEAM` in test mode.
  - Set `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET` (test signing secret).
  - Webhook endpoint: `/v1/billing/webhook`; events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
  - Run checkout/portal from dashboard with test card; confirm billing status reflects trial/active.
- Live mode checklist:
  - Create live prices → set `STRIPE_PRICE_PRO` and `STRIPE_PRICE_TEAM` (live).
  - Switch secrets to live keys.
  - Update Stripe webhook to production URL and capture live signing secret.
  - Re-run a live Checkout smoke (tiny $0 test price if available or real Pro).
- Backup & restore readiness:
  - [ ] RPO/RTO targets agreed (see BACKUP_RESTORE.md)
  - [ ] Backup mechanism in place (Supabase or pg_dump) and last success timestamp recorded
  - [ ] Restore drill completed in staging (see BACKUP_RESTORE.md) and documented

## 4) Common misconfig symptoms
- `billing_webhook_signature_invalid`: webhook secret mismatch or wrong endpoint URL.
- `billing_webhook_workspace_not_found`: Stripe customer not mapped to workspace (customer created outside flow); backfill `stripe_customer_id` then replay events.
- `cap_exceeded`: users hitting plan caps (good conversion signal) or caps set too low.
- `billing_endpoint_error`: checkout/portal/status failing due to Stripe env/config/API.

## 5) Cloudflare deploy checklist
- `wrangler.toml`: Durable Object binding present (`RATE_LIMIT_DO` → class `RateLimitDO`).
- Env vars in Cloudflare dashboard match `.dev.vars` (without secrets checked into git).
- Set `ALLOWED_ORIGINS` correctly; default deny.
- KV no longer used for rate limit (ensure old bindings not referenced).

## 6) Smoke checklist (pre-deploy + post-deploy)
- Local or staging: `bash scripts/e2e_smoke.sh` (or `powershell -File scripts/e2e_smoke.ps1`).
  - Expect: /healthz ok; POST /v1/memories ok; /v1/search, /v1/context return hits; /v1/usage/today returns counts.
- For prod: run smoke against production base URL with `E2E_API_KEY` from a prod workspace (stub embeddings not required in prod).

## 7) Rollback plan
- Worker: deploy previous Wrangler version (git ref or `wrangler deploy --env prod --config ... --compatibility-date <prior>`).
- Do NOT rollback database migrations; they are forward-only. If billing data issues arise, correct rows manually or with follow-up migrations.
- If Stripe caused issues, disable webhook endpoint in Stripe dashboard while investigating (does not roll back DB).

## 8) Post-launch checks
- Billing sanity: `/v1/billing/status` returns `plan_status` active/trialing for paid workspaces; `effective_plan` matches expectations.
- Logs: watch for `billing_webhook_signature_invalid`, `billing_webhook_workspace_not_found`, `billing_endpoint_error`, `cap_exceeded`.
- Caps conversion: spikes in `cap_exceeded` may indicate upgrade opportunity or caps tuned too low.
- Error rate: ensure 5xx stays near zero; investigate structured logs by `event_name`.

## 9) Quick commands/snippets
- Re-run billing status: `curl -H "Authorization: Bearer $API_KEY" "$API_BASE/v1/billing/status"`
- Replay Stripe event (from dashboard) after fixing mapping.
- Check RLS enabled: `select relrowsecurity from pg_class where relname='memories';`
