## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# Security Readiness One-Pager

Secret names and required sets change with releases. Cross-check `apps/api/src/env.js`, `wrangler.toml`, and your Cloudflare/Supabase dashboards before go-live.

Purpose: checklist for release-critical secrets and steps to keep production safe (not a substitute for live env audit).

## 1) Required Secrets and Config by Environment

Use this matrix as the minimum set for staging and production.

| Key | Staging | Production | Why it matters | Owner |
| --- | --- | --- | --- | --- |
| SUPABASE_URL | Required | Required | API database/auth endpoint | Platform owner |
| SUPABASE_SERVICE_ROLE_KEY | Required | Required | Privileged API access to Supabase | Platform owner |
| SUPABASE_ANON_KEY | Required | Required | Dashboard session verification path | Platform owner |
| API_KEY_SALT | Required | Required | Hashing API keys securely | Platform owner |
| MASTER_ADMIN_TOKEN | Required | Required | Protects admin endpoints | Platform owner |
| DATABASE_URL or SUPABASE_DB_URL | Required | Required | DB migrations and schema checks | Platform owner |
| ALLOWED_ORIGINS | Required | Required | Dashboard browser origin allowlist | Platform owner |
| EMBEDDINGS_MODE | Required | Required | Chooses stub/openai embedding path | Platform owner |
| OPENAI_API_KEY (if EMBEDDINGS_MODE=openai) | Conditional | Conditional | OpenAI embedding authentication | AI owner |
| AI_COST_BUDGET_INR | Recommended | Required | Global AI spend kill switch | Founder/Finance owner |
| PAYU_MERCHANT_KEY | Required when billing enabled | Required when billing enabled | Checkout integration | Billing owner |
| PAYU_MERCHANT_SALT | Required when billing enabled | Required when billing enabled | PayU signature verification | Billing owner |
| PAYU_WEBHOOK_SECRET | Recommended | Recommended | Extra webhook verification layer | Billing owner |
| PAYU_BASE_URL | Required when billing enabled | Required when billing enabled | Payment endpoint | Billing owner |
| PAYU_VERIFY_URL | Required when billing enabled | Required when billing enabled | Verify-before-grant control | Billing owner |
| PUBLIC_APP_URL | Required when billing enabled | Required when billing enabled | Checkout callback URL generation | Platform owner |
| CLOUDFLARE_API_TOKEN | Optional (ops scripts) | Optional (ops scripts) | Cloudflare audit/ops tooling | DevOps owner |

## 2) Rules

- Never commit real secret values to git.
- Keep template files empty for secret fields.
- Put runtime secrets in Cloudflare Worker secrets or CI secret manager.
- Rotate immediately if any secret is exposed.

## 3) What Was Fixed in This Cleanup

- Removed hardcoded default admin token from `apps/api/.dev.vars.template`.
- Removed unused `RATE_LIMIT_SECRET` key from `.env.example` to reduce configuration drift.

## 4) Remaining Steps After This Cleanup

1. Verify all required secrets exist in staging and production secret stores.
2. Run release validation flow (`check:config`, smoke, billing webhook path).
3. Confirm `ALLOWED_ORIGINS` includes correct dashboard domains.
4. Confirm production runs with `EMBEDDINGS_MODE=openai` and a valid `OPENAI_API_KEY` (if using real embeddings).
5. Perform one tabletop secret-rotation drill for `MASTER_ADMIN_TOKEN`, `API_KEY_SALT`, and PayU credentials.

## 5) Pre-Release Signoff

Mark ready only when all are true:

- Config check passes for target environment.
- Smoke and post-deploy validation pass.
- Billing webhook verification is passing.
- No hardcoded token-like values in tracked files.
- Owner for each secret is explicitly assigned.
