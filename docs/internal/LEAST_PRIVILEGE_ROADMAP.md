# Least-Privilege Roadmap

Tracks MemoryNode's migration from service-role-heavy request paths to DB-enforced tenant isolation. Required by [scripts/check_least_privilege_contract.mjs](../../scripts/check_least_privilege_contract.mjs); this file must always contain the literal string `rls-first` and the supporting migrations `047_workspace_scoped_memory_rpcs.sql`, `048_list_memories_scoped_rpc.sql`, `049_request_path_rls_first.sql` must exist in `infra/sql/`.

## Access modes

`SUPABASE_ACCESS_MODE` ([apps/api/src/env.ts](../../apps/api/src/env.ts)) is one of:

- `service-role-only` — legacy, forbidden in production by `CHECK_ENV=production pnpm check:config`.
- `rpc-first` — current default; all tenant operations go through workspace-scoped RPCs with fail-closed behavior.
- `rls-first` — Phase B target; the request path uses a short-lived Supabase JWT and RLS policies are the primary boundary. Requires `SUPABASE_JWT_SECRET` and `SUPABASE_ANON_KEY` (validated in `validateSecrets`).

Two companion toggles interact with `rls-first`:

| Env var | Meaning |
| --- | --- |
| `REQUEST_SCOPED_DB_ENABLED=1` | Issue a request-scoped JWT on every tenant request. |
| `DISABLE_SERVICE_ROLE_REQUEST_PATH=1` | Hard kill-switch: admin and billing-webhook routes return `503 CONTROL_PLANE_ONLY`. |

## Completed migrations

1. `infra/sql/047_workspace_scoped_memory_rpcs.sql`
   - `get_memory_scoped(p_memory_id, p_workspace_id)`
   - `delete_memory_scoped(p_memory_id, p_workspace_id)`
2. `infra/sql/048_list_memories_scoped_rpc.sql`
   - `list_memories_scoped` (paginated, workspace-scoped).
3. `infra/sql/049_request_path_rls_first.sql`
   - `alter table ... force row level security` on every tenant-owned table.
   - Hardened `workspace_members_self_insert` policy (owner-gated; service-role exception only).
   - Request-path auth RPCs: `authenticate_api_key`, `touch_api_key_usage`.
   - JWT-claim-aware membership helper `is_workspace_member`.

All four strings (`force row level security`, `authenticate_api_key`, `touch_api_key_usage`, `workspace_members_self_insert`, `is_workspace_member`) must be present in `049_request_path_rls_first.sql` for `pnpm check:least-privilege` to pass.

## Phase A guarantees (current production posture)

1. Fail-closed tenant paths: `performListMemories`, `get_memory_scoped`, and `delete_memory_scoped` cannot fall back to service-role when scoped access fails.
2. `workspace_members` self-insert policy is owner-gated; the service-role exception is narrowly scoped.
3. CI enforces request-path least privilege:
   - Fallback markers reintroducing service-role in the request path fail the build ([scripts/check_request_path_least_privilege.mjs](../../scripts/check_request_path_least_privilege.mjs)).
   - Service-role client construction is allowlist-only (`scripts/security/service_role_allowlist.json`).
4. Cross-tenant adversarial tests run in CI.

## Phase B rollout plan (`rls-first`)

1. Bring `SUPABASE_ACCESS_MODE=rls-first` + `REQUEST_SCOPED_DB_ENABLED=1` to staging. Validate:
   - `/v1/search`, `/v1/context`, `/v1/memories` succeed end-to-end.
   - `db_access_path_selected` log reports `mode="rls-first"` for tenant routes.
2. Promote to production; observe for 24 h.
3. Enable `DISABLE_SERVICE_ROLE_REQUEST_PATH=1`. Admin and billing-webhook routes must remain on a dedicated control-plane path (they return `503 CONTROL_PLANE_ONLY` when the switch is on in the request path).
4. Shrink remaining direct table access by moving mutating paths to explicit RPC contracts where needed.

## Exit criteria

- Zero direct tenant-table queries in request handlers without a scoped RPC or short-lived JWT.
- RLS is the primary boundary on every tenant-owned table.
- Cross-tenant adversarial tests pass in CI on every PR.
- `pnpm check:request-path-least-privilege` passes with no allowlist entries for request-path code.

## Non-goals

- Admin control plane (/admin/*, scheduled jobs via GitHub Actions) continues to use service role; those call sites live in the allowlist.
- Billing-webhook handlers keep service role until PayU reconciliation can be factored behind a control-plane worker.
