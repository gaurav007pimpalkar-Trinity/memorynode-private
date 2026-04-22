# Security

Security posture of the MemoryNode Cloudflare Worker (`memorynode-api`) and its Supabase data plane, anchored to the code in `apps/api/src/` and `infra/sql/`. Report vulnerabilities privately to `security@memorynode.ai`.

## 1. Threat model summary

- Tenants share one Worker and one Supabase Postgres project. Isolation is enforced through hashed API keys, workspace-scoped RPCs, and (in `rls-first`) Postgres RLS policies.
- Billing is PayU-only. The Worker never sees card data; PayU handles the hosted checkout. Stripe paths are retired.
- The Worker is the only first-party HTTP surface. Cloudflare Pages apps consume it via CORS + session cookie + CSRF.

## 2. Authentication modes

Full table in [docs/external/API_USAGE.md §1](./external/API_USAGE.md). Summary:

| Mode | How it's proved | Verifier |
| --- | --- | --- |
| API key | `Authorization: Bearer <key>` / `x-api-key` | SHA-256 + `API_KEY_SALT`, `authenticate_api_key` RPC |
| Dashboard session | `Cookie: mn_session` + `x-csrf-token` | `dashboard_sessions` row + constant-time CSRF compare |
| Admin | `x-admin-token` (legacy equality or HMAC-signed) | `MASTER_ADMIN_TOKEN`, optional `ADMIN_ALLOWED_IPS` |
| Memory webhook | `X-MN-Webhook-Signature` | HMAC-SHA256 against `memory_ingest_webhooks.signing_secret` |
| PayU webhook | form body | Reverse SHA-512 with `PAYU_MERCHANT_SALT`, HMAC-SHA256 fallback on `PAYU_WEBHOOK_SECRET` |
| Internal MCP | `x-internal-mcp: 1` + `x-internal-secret` | Constant-time compare against `MCP_INTERNAL_SECRET` |

All comparisons that touch secrets use `crypto.timingSafeEqual` where available.

## 3. Secret handling

Secrets live only in Cloudflare Worker `wrangler secret` storage (never in `wrangler.toml [vars]`) or Supabase Vault.

Required in production (enforced by `validateSecrets` in [apps/api/src/env.ts](../apps/api/src/env.ts)):

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`
- `API_KEY_SALT` (≥ 16 chars), `MASTER_ADMIN_TOKEN` (≥ 24 chars)
- `OPENAI_API_KEY` (when `EMBEDDINGS_MODE=openai`)
- `AI_COST_BUDGET_INR` (`> 0`)
- `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_WEBHOOK_SECRET`

Stub modes (`SUPABASE_MODE=stub`, `EMBEDDINGS_MODE=stub`) are forbidden in production by `validateStubModes`. `RATE_LIMIT_MODE=off` is forbidden in production by `validateRateLimitConfig`.

## 4. Row-level security and tenant isolation

- `SUPABASE_ACCESS_MODE` ∈ `{ service-role-only (legacy, blocked in prod), rpc-first (current), rls-first (target) }`.
- Every tenant-owned table has `alter table ... force row level security` set in [infra/sql/049_request_path_rls_first.sql](../infra/sql/049_request_path_rls_first.sql).
- Request-path RPCs (`authenticate_api_key`, `touch_api_key_usage`, `get_memory_scoped`, `delete_memory_scoped`, `list_memories_scoped`) are fail-closed.
- Cross-tenant adversarial tests run in CI.
- `enforceIsolation` ([apps/api/src/middleware/isolation.ts](../apps/api/src/middleware/isolation.ts)) rejects any attempt to reach a namespace outside the caller's workspace with `403 FORBIDDEN`.
- Service-role usage in the request path is allowlisted by `scripts/security/service_role_allowlist.json` and enforced by CI.

See [docs/internal/LEAST_PRIVILEGE_ROADMAP.md](./internal/LEAST_PRIVILEGE_ROADMAP.md).

## 5. Rate limiting, concurrency, cost guards

- Per-key RPM (60, 15 for first 48 h of a new key) and per-workspace RPM (120, 300 on `scale`) via `RATE_LIMIT_DO` Durable Object.
- Workspace concurrency cap of 8 in-flight quota-consuming requests (`WORKSPACE_CONCURRENCY_MAX`).
- Cost/minute burst guard (`WORKSPACE_COST_PER_MINUTE_CAP_INR`, default 15 INR).
- Quota reservations via `reserve_usage_if_within_cap` + `commit_usage_reservation` are atomic in Postgres.
- Global AI spend guard (`AI_COST_BUDGET_INR`) fails closed in production; `AI_COST_GUARD_FAIL_OPEN` must not be set.
- Circuit breakers (OpenAI embed, OpenAI extract, Supabase RPC, PayU verify) share state through `CIRCUIT_BREAKER_DO` when bound.

## 6. Webhook signatures

### 6.1 PayU

Handler: [apps/api/src/handlers/billingWebhook.ts](../apps/api/src/handlers/billingWebhook.ts).

- Primary: reverse SHA-512 computed over the PayU fields using `PAYU_MERCHANT_SALT`.
- Fallback: `x-payu-webhook-signature` as HMAC-SHA256 over the raw body keyed by `PAYU_WEBHOOK_SECRET`.
- On signature failure → `billing_webhook_signature_invalid` event (alert **D2**).
- Verify-before-grant: only after signature success **and** a successful PayU verify-API response does the Worker call `upsertWorkspaceEntitlementFromTransaction`.
- Idempotent via `payu_webhook_events`.

### 6.2 Memory ingest

Handler: `POST /v1/webhooks/memory` in [apps/api/src/router.ts](../apps/api/src/router.ts).

- HMAC-SHA256 on the raw body keyed by `memory_ingest_webhooks.signing_secret` for the target workspace.
- On success the Worker synthesizes an internal trusted auth header pair (`MEMORY_WEBHOOK_INTERNAL_TOKEN` — Worker-only secret) and forwards to `POST /v1/memories`.

## 7. CSRF and session cookies

- `mn_session` is HttpOnly, Secure, SameSite=Lax, Path=/, tied to one workspace.
- CSRF double-submit is required on every non-GET `/v1/*` call from dashboard sessions; server compare is constant-time.
- Sessions are cleaned up via `POST /admin/sessions/cleanup` (and a scheduled GitHub Action).

## 8. Origins and CORS

`ALLOWED_ORIGINS` is a comma-separated allowlist. The Worker rejects cross-origin requests from origins not on the list, except hosted MCP paths which must be permissive to support third-party clients. Responses always emit security headers (HSTS, X-Content-Type-Options, Referrer-Policy, etc.) from the ensemble in [apps/api/src/workerApp.ts](../apps/api/src/workerApp.ts).

## 9. Admin control plane

- `x-admin-token` required for `/admin/*` and `/v1/admin/*`.
- Two modes:
  - `legacy` — equality compare on `MASTER_ADMIN_TOKEN`.
  - `signed-required` — HMAC-signed headers (timestamp-bound).
- `ADMIN_ALLOWED_IPS` pins admin calls to a bastion/CI egress list (`*` disables — emergency only).
- `ADMIN_BREAK_GLASS=1` is a narrowly-scoped override to fall back to legacy auth inside `signed-required`; disable by default.
- When `DISABLE_SERVICE_ROLE_REQUEST_PATH=1`, admin routes return `503 CONTROL_PLANE_ONLY` — admin must be executed from a dedicated control-plane path.

## 10. Audit and request id

- `x-request-id` on every response.
- `emitAuditLog` writes `api_audit_log` rows with salted-SHA-256 of client IP (`AUDIT_IP_SALT`).
- Structured `request_completed` log emitted on every request (see [docs/internal/OBSERVABILITY.md](./internal/OBSERVABILITY.md)).

## 11. Secret rotation checklist

Documented in [docs/internal/IDENTITY_TENANCY.md §5](./internal/IDENTITY_TENANCY.md). Hard rules:

- Never put live Stripe secrets into the Worker; Stripe is retired.
- Rotate `MASTER_ADMIN_TOKEN` on any suspected compromise; log the rotation.
- Rotate `API_KEY_SALT` only through the documented procedure (re-issuing customer keys in a scheduled window).

## 12. Known constraints

- Stripe billing tables (`infra/sql/016_webhook_events.sql` and earlier) remain for historical queries; no code path writes to them.
- `/v1/billing/portal` always returns 410. Customers manage subscriptions in the PayU dashboard.
- Data plane is single-region Supabase; DR posture tracked in [docs/internal/INCIDENT_RUNBOOKS.md](./internal/INCIDENT_RUNBOOKS.md).

## 13. Reporting

Email `security@memorynode.ai` with:

- Endpoint and request id (`x-request-id`) if reproducible.
- Environment (`api.memorynode.ai` vs `api-staging.memorynode.ai`).
- Steps to reproduce and expected vs observed behavior.

Do not open public issues for suspected vulnerabilities.
