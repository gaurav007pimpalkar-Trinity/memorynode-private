## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# Least-Privilege Roadmap (Phase A Startup-Safe)

This roadmap tracks a pragmatic migration from service-role-heavy request paths to stronger DB-enforced isolation, optimized for a solo/small team.

## Access Modes

- `service-role-only` (legacy): all request-path DB access via service role.
- `rpc-first` (current Phase A posture): critical tenant operations use scoped RPCs with fail-closed behavior.
- `rls-first` (Phase B+ target): request-path data access uses scoped credentials/JWT where RLS is the primary boundary.

`CHECK_ENV=production pnpm check:config` forbids `SUPABASE_ACCESS_MODE=service-role-only`.

## Completed migration steps

1. `047_workspace_scoped_memory_rpcs.sql`
   - `get_memory_scoped`
   - `delete_memory_scoped`
2. `048_list_memories_scoped_rpc.sql`
   - `list_memories_scoped`
3. `049_request_path_rls_first.sql`
   - force RLS on core tenant tables
   - hardened `workspace_members_self_insert` policy
   - request-path auth RPCs (`authenticate_api_key`, `touch_api_key_usage`)
   - scoped JWT claim-aware membership helper (`is_workspace_member`)

## Phase A guarantees (current)

1. Critical fallback paths removed: `performListMemories`, `get_memory_scoped`, `delete_memory_scoped` are fail-closed.
2. `workspace_members` self-insert policy hardened (owner-gated, service-role exception only).
3. CI enforces request-path least-privilege:
   - fallback marker reintroduction fails builds
   - service-role client creation is allowlist-only (`scripts/security/service_role_allowlist.json`)
4. Cross-tenant adversarial tests remain required in CI.

## Deferred rollout work (Phase B+)

1. Operate with `SUPABASE_ACCESS_MODE=rls-first`, `REQUEST_SCOPED_DB_ENABLED=1`, `DISABLE_SERVICE_ROLE_REQUEST_PATH=1` in staging, then production.
2. Keep service role limited to control-plane jobs outside request serving.
3. Continue shrinking direct table access by moving remaining mutating paths to strict RPC contracts where needed.
4. Keep CI policy failing on request-path service-role and fallback reintroduction.

## Exit criteria

- No direct tenant-data table queries in request handlers without scoped DB contract.
- RLS is the primary boundary for request-path access.
- Cross-tenant adversarial tests pass in CI.
