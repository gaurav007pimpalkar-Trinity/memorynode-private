# Status Snapshot

## Implemented (evidence)
- Core memory CRUD, search, context endpoints wired in Worker (`apps/api/src/index.ts:430-1175`) with hybrid RRF using Supabase RPCs (`infra/sql/002_rpc.sql`).
- Usage tracking and caps: `usage_daily` table + `bump_usage` RPC (`infra/sql/003_usage_rpc.sql`), enforced via `checkCapsAndMaybeRespond` (`apps/api/src/index.ts:298-333, 2634-2664`).
- Export/Import with manifest v1 and ZIP support (`apps/api/src/index.ts:1540-1695, 2585-2631`).
- Admin control plane (workspace/API key lifecycle) with `x-admin-token` (`apps/api/src/index.ts:2365-2547`).
- Billing scaffolding: status/checkout/portal/webhook endpoints with Stripe env validation and webhook storage (`apps/api/src/index.ts:2667-2977`; `infra/sql/012_billing.sql`, `016_webhook_events.sql`).
- Security controls: rate limiting via Durable Object (`apps/api/src/rateLimitDO.ts`), RLS policies (`infra/sql/006_rls.sql`, `008_membership_rls.sql`), audit/product event logging (`apps/api/src/index.ts:70-120, 1410-1478`; `infra/sql/005_api_audit_log.sql`, `013_events.sql`).
- Dashboard MVP with auth, API key management, memory browser/search, usage, billing UI, invites/members tabs (`apps/dashboard/src/App.tsx`).
- SDK covering all public endpoints (`packages/sdk/src/index.ts`).

## Partial / In-progress
- Typecheck failing: `corepack pnpm typecheck` exits due to `STRIPE_SECRET_KEY` possibly undefined in `getStripeClient` (`apps/api/src/index.ts:214-230`).
- Billing portal/checkout rely on Stripe; functional correctness depends on external configuration (env validation present but no integration tests beyond unit mocks).

## Not Implemented (proven)
- No backlog of TODO/FIXME found (`rg TODO|FIXME` returned no matches).  
- No evidence of analytics pipeline beyond product_events table — external forwarding unknown (deployment-specific).

## Quality Signals
- Tests: `corepack pnpm test` passes 23 Vitest files (API + SDK) covering rate limits, billing, export/import, search, security headers (command output).
- Lint: `corepack pnpm lint` passes.
- Smoke: `corepack pnpm smoke:ps` succeeds (hits /healthz, workspace/key creation, ingest/search/context) (`scripts/smoke.ps1` output).
- Typecheck: failing (see Partial).
