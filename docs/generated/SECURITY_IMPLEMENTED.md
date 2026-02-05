# Security (Implemented)

## Auth & AuthZ
- **API key authentication**: accepted via `x-api-key` or `Authorization: Bearer` headers, hashed with `API_KEY_SALT` (env or `app_settings` table) inside `authenticate` (`apps/api/src/index.ts:1185-1235`; `infra/sql/011_api_key_rpcs.sql` provides salt RPC and API key creation).
- **Admin control plane**: endpoints `/v1/workspaces`, `/v1/api-keys`, `/v1/api-keys/revoke` require `x-admin-token` validated in `requireAdmin` (`apps/api/src/index.ts:2320-2365`).
- **Tenant isolation (DB)**: Row Level Security enabled across `workspaces`, `api_keys`, `memories`, `memory_chunks`, `usage_daily`, `api_audit_log`; membership-based policies via `workspace_members` enforced in `infra/sql/006_rls.sql` and strengthened in `infra/sql/008_membership_rls.sql`.
- **Workspace membership & invites**: Owner-managed roles and invite RPCs in `infra/sql/015_invites.sql`; policies restrict to members/owners.

## Rate Limiting & Quotas
- **Per-key rate limit**: Durable Object `RateLimitDO` counts requests per window (`apps/api/src/rateLimitDO.ts`); applied to all protected routes via `rateLimit` (`apps/api/src/index.ts:2295-2317`). Failure returns 429 with headers `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `retry-after`.
- **Daily usage caps**: Plan caps from `apps/api/src/limits.ts` enforced through `checkCapsAndMaybeRespond` on ingest/search/context (`apps/api/src/index.ts:298-333`).
- **Body size caps**: Route-specific limits in `resolveBodyLimit` (memories/search/context/import/export/admin) (`apps/api/src/index.ts:373-392`).

## Input Validation & Safety
- Text/query length checks (`MAX_TEXT_CHARS`, `MAX_QUERY_CHARS`) and pagination clamps in `normalizeSearchPayload` and handlers (`apps/api/src/index.ts:1215-1310`, `830-930`).
- Metadata filters must be primitive JSON; invalid filters return 400 (`apps/api/src/index.ts:1245-1285`).
- Import/export size enforcement (`apps/api/src/index.ts:1540-1635`, `1608-1695`).

## Network / Headers
- CORS allowlist via `ALLOWED_ORIGINS`; preflight handled; `buildSecurityHeaders` adds `x-content-type-options`, `referrer-policy`, `permissions-policy`, and `cache-control: no-store` for sensitive paths (`apps/api/src/index.ts:399-417`).
- Security headers tested in `apps/api/tests/security_headers.test.ts`.

## Secrets Handling
- Redaction for logs in `redact` masks secret-like values (`apps/api/src/index.ts:1497-1525`).
- Stripe env validation blocks prod calls when keys missing (`apps/api/src/index.ts:180-230`).

## Audit & Logging
- Request audit persisted to `api_audit_log` with salted IP using `AUDIT_IP_SALT` (`apps/api/src/index.ts:1410-1478`; `infra/sql/005_api_audit_log.sql`).
- Product events stored in `product_events` via `emitProductEvent` (`apps/api/src/index.ts:70-120, 239-260`; `infra/sql/013_events.sql`).
- Request summary logs emitted per request (`apps/api/src/index.ts:520-550`).

## Billing/Webhooks
- Stripe webhook signature verification using raw body and `STRIPE_WEBHOOK_SECRET` (`apps/api/src/index.ts:2870-2940`); events stored in `stripe_webhook_events` (`infra/sql/016_webhook_events.sql`).

## Not Implemented / Unknown
- No evidence of TLS termination or IP allowlists in repo (deployment-dependent) — Unknown from repo scan.
- No evidence of secrets rotation or key revocation automation beyond manual revoke endpoint — Unknown from repo scan.
