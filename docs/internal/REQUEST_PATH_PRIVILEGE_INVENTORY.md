## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# Request-Path Privilege Inventory

This inventory is the Track C source of truth for request-path trust boundaries.

## Critical

- `apps/api/src/workerApp.ts`
  - `createSupabaseClient()` historical service-role fanout for route handlers.
  - `performListMemories()`, `getMemoryByIdScoped()`, `deleteMemoryCascade()` had scoped-RPC fallback to direct query path.
- `apps/api/src/router.ts`
  - single DB client fanout into all handlers.

## High

- `apps/api/src/auth.ts`
  - API key validation and salt read were direct table reads.
- `apps/api/src/handlers/memories.ts`
  - direct `memories` and `memory_chunks` writes.
- `apps/api/src/handlers/search.ts`
  - direct `search_query_history` read/write/delete.
- `apps/api/src/handlers/billing.ts`
  - direct `payu_transactions` / `workspaces` write path.
- `apps/api/src/handlers/apiKeys.ts`
  - direct `api_keys` CRUD.
- `apps/api/src/handlers/workspaces.ts`
  - direct `workspaces` insert.

## Medium

- `apps/api/src/handlers/admin.ts`
  - global control-plane operations in request-serving runtime.
- `scripts/lib/workspace_scope_guard.mjs`
  - regex-only static coverage; misses complex query shapes.

## Controls added in Track C

- Request-path client factory split in `apps/api/src/dbClientFactory.ts`.
- Scoped JWT minting in `apps/api/src/requestIdentity.ts`.
- SQL hardening in `infra/sql/049_request_path_rls_first.sql`.
- Static enforcement in `scripts/check_request_path_least_privilege.mjs`.
