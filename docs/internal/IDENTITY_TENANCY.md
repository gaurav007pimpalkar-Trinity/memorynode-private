# Identity and Tenancy

How MemoryNode decides who the caller is and which tenant they may touch. Source of truth: [apps/api/src/auth.ts](../../apps/api/src/auth.ts), [apps/api/src/middleware/isolation.ts](../../apps/api/src/middleware/isolation.ts), and the RLS migrations in `infra/sql/`.

## 1. Identity model

- **Workspace** — top-level tenant. Billing entity. Has an entitlement (`workspace_entitlements`), a set of members (`workspace_members`), and zero or more API keys.
- **API key** — bearer credential scoped to a single workspace. Hashed with SHA-256 + `API_KEY_SALT` before storage.
- **Dashboard session** — Supabase Google OAuth → short-lived server row (`dashboard_sessions`) → cookie + CSRF token, scoped to one workspace chosen at login.
- **Admin** — holder of `MASTER_ADMIN_TOKEN` (optionally HMAC-signed via `ADMIN_AUTH_MODE=signed-required`, optionally IP-pinned via `ADMIN_ALLOWED_IPS`). Not bound to a workspace.
- **Memory webhook** — per-workspace signing secret in `memory_ingest_webhooks.signing_secret`. Validated by HMAC-SHA256 on `X-MN-Webhook-Signature`.
- **PayU webhook** — unsigned from the workspace's perspective; validated against `PAYU_MERCHANT_SALT` (reverse SHA-512) with HMAC-SHA256 fallback on `PAYU_WEBHOOK_SECRET`.
- **Internal MCP** — subrequest identity set by the hosted MCP path (`x-internal-mcp: 1` + `x-internal-secret`).

## 2. Auth matrix

Abbreviated; full table in [docs/external/API_USAGE.md §1](../external/API_USAGE.md).

| Mode | Header(s) | Paths |
| --- | --- | --- |
| API key (K) | `Authorization: Bearer` or `x-api-key` | `/v1/*` tenant routes |
| Dashboard session (S) | `Cookie: mn_session` + `x-csrf-token` | `/v1/*` tenant routes, plus `/v1/dashboard/*` |
| Admin (A) | `x-admin-token` | `/admin/*`, `/v1/admin/*` |
| Memory webhook (H) | `X-MN-Webhook-Signature` | `POST /v1/webhooks/memory` |
| PayU webhook (H) | form + reverse SHA-512 / HMAC | `POST /v1/billing/webhook` |
| Internal MCP (I) | `x-internal-mcp` + `x-internal-secret` | Internal hosted-MCP subrequests to `/v1/*` |
| Public (P) | — | `/healthz`, `/ready`, `/v1/health` |

## 3. Isolation middleware

Every tenant handler that touches memories or namespaces calls `enforceIsolation` ([apps/api/src/middleware/isolation.ts](../../apps/api/src/middleware/isolation.ts)).

Inputs: the resolved workspace id (from auth), the requested `namespace` / `owner_id`, and the current access mode. Outputs on the response:

- `x-mn-resolved-container-tag` — the namespace the request will write to / read from.
- `x-mn-routing-mode` — one of `service-role`, `rpc-first`, or `rls-first`; matches `SUPABASE_ACCESS_MODE`.

Any mismatch between the caller's identity and the requested target is rejected with `403 FORBIDDEN` before any DB work.

## 4. Access modes

Controlled by `SUPABASE_ACCESS_MODE` (see [LEAST_PRIVILEGE_ROADMAP.md](./LEAST_PRIVILEGE_ROADMAP.md)):

- `service-role-only` — legacy; forbidden in production by `CHECK_ENV=production pnpm check:config`.
- `rpc-first` — current production posture. All tenant ops go through workspace-scoped RPCs (`get_memory_scoped`, `delete_memory_scoped`, `list_memories_scoped`, etc.). Service role remains available to handlers but is bounded by RPC contracts.
- `rls-first` — target. The Worker mints a short-lived Supabase JWT for each request (requires `SUPABASE_JWT_SECRET`), and RLS policies are the primary boundary. Enable with `SUPABASE_ACCESS_MODE=rls-first` + `REQUEST_SCOPED_DB_ENABLED=1` + `DISABLE_SERVICE_ROLE_REQUEST_PATH=1`.

RLS-first depends on:

- `authenticate_api_key(p_key_hash)` RPC → returns workspace + api_key row.
- `current_workspace_id()` — reads JWT `workspace_id` claim.
- `is_workspace_member(workspace, user)` — consults `workspace_members` with the JWT claim.
- `force row level security` is asserted on every tenant-owned table (migration `049_request_path_rls_first.sql`).

## 5. Key rotation and revocation

- API keys: issued through `POST /v1/api-keys`, revoked through `POST /v1/api-keys/revoke`. First 48 h after `api_keys.created_at` the per-key RPM is 15; afterwards 60.
- Dashboard sessions: `POST /v1/dashboard/logout` deletes the row; `POST /admin/sessions/cleanup` evicts expired rows.
- `API_KEY_SALT` rotation requires re-hashing all keys; practical procedure is to issue new keys, rotate salt, and revoke old keys.
- `MASTER_ADMIN_TOKEN`: rotate with `wrangler secret put`; document the rotation in `api_audit_log`.
- `MCP_INTERNAL_SECRET`: rotate with `wrangler secret put`; hosted MCP → REST subrequests fail until redeploy completes.
- `MEMORY_WEBHOOK_INTERNAL_TOKEN`: same procedure.

## 6. Tenant-scoped errors

| Code | When |
| --- | --- |
| `UNAUTHORIZED` | Missing or unrecognized credentials |
| `FORBIDDEN` | Recognized identity but not permitted on the resource (isolation mismatch, insufficient plan) |
| `CONTROL_PLANE_ONLY` | `/admin/*` or billing-webhook called while `DISABLE_SERVICE_ROLE_REQUEST_PATH=1` |
| `TRIAL_EXPIRED` | Workspace trial ended without a paid plan |
| `CAP_EXCEEDED` | Quota reservation rejected (see [BILLING_RUNBOOK.md](./BILLING_RUNBOOK.md)) |
| `COST_BUDGET_EXCEEDED` | Global AI cost guard tripped |

## 7. Admin vs control plane

Admin endpoints share the same Worker but never carry tenant credentials. When `DISABLE_SERVICE_ROLE_REQUEST_PATH=1` the Worker actively rejects admin routes with `503 CONTROL_PLANE_ONLY`, so those routes must be hit from a separate control-plane path (e.g., scheduled GitHub Actions pointed at a mode-specific variant of the Worker or a different deployment that keeps service role available).

## 8. Related

- Auth surface table: [docs/external/API_USAGE.md §1](../external/API_USAGE.md).
- Session flow: [DASHBOARD_SESSION_SETUP.md](./DASHBOARD_SESSION_SETUP.md).
- Security review: [docs/SECURITY.md](../SECURITY.md).
