# Database Schema (from infra/sql)

## Core Tables (001_init.sql)
- `workspaces` — `id uuid pk default gen_random_uuid()`, `name text not null`, `plan text not null default 'free' check in ('free','pro','team')`, `created_at timestamptz default now()`.
- `api_keys` — `id uuid pk`, `workspace_id uuid fk workspaces on delete cascade`, `name text not null`, `key_hash text not null unique`, `created_at timestamptz default now()`, `revoked_at timestamptz`.
- `memories` — `id uuid pk`, `workspace_id uuid fk workspaces cascade`, `user_id text not null`, `namespace text not null default 'default'`, `text text not null`, `metadata jsonb not null default '{}'`, `created_at timestamptz default now()`.
- `memory_chunks` — `id uuid pk`, `workspace_id uuid fk workspaces cascade`, `memory_id uuid fk memories cascade`, `user_id text not null`, `namespace text not null default 'default'`, `chunk_index int not null`, `chunk_text text not null`, `embedding vector(1536) not null`, `tsv tsvector generated always as to_tsvector('english', coalesce(chunk_text,'')) stored`, `created_at timestamptz default now()`, unique (memory_id, chunk_index).
- `usage_daily` — `workspace_id uuid fk workspaces cascade`, `day date pk part`, `writes int default 0`, `embeds int default 0`, `reads int default 0`, primary key (workspace_id, day).
- Indexes: ivfflat on `memory_chunks.embedding` (vector_cosine_ops, lists=100); GIN on `memory_chunks.tsv`; workspace/user/namespace indexes on memories and memory_chunks.

## Audit & Billing
- `api_audit_log` (`005_api_audit_log.sql`) — request log columns including `workspace_id`, `api_key_id`, `route`, `method`, `status`, `bytes_in/out`, `latency_ms`, `ip_hash`, `user_agent`, `created_at`; indexes on route and created_at desc.
- Billing fields on `workspaces` (`012_billing.sql`): `stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`, `plan_status` check in ('free','trialing','active','past_due','canceled'), `current_period_end`, `cancel_at_period_end`, `updated_at`; indexes on stripe ids.
- `product_events` (`013_events.sql`) — `workspace_id fk`, `event_name`, `request_id`, `route`, `method`, `status`, `effective_plan`, `plan_status`, `props jsonb`, `created_at`; indexes on (workspace_id, created_at desc) and (event_name, created_at desc).
- `stripe_webhook_events` (`016_webhook_events.sql`) — stores webhook payload metadata (event_id, type, workspace_id, customer_id, status, created_at); indexes on event_id, workspace_id, customer_id.

## Membership & Invites
- `workspace_members` (`008_membership_rls.sql`) — `workspace_id uuid fk`, `user_id uuid`, `role text default 'member'`, `created_at`; pk (workspace_id, user_id); index on user_id.
- `workspace_invites` (`015_invites.sql`) — `workspace_id fk`, `email text`, `role text check in ('member','admin','owner')`, `token text unique`, `created_by uuid`, `expires_at`, `accepted_at`, `accepted_by`, `revoked_at`; indexes: (workspace_id, created_at desc), (lower(email), workspace_id), unique pending invite; role check constraint.

## Policies (RLS)
- Baseline RLS enabling and policies in `infra/sql/006_rls.sql` for `workspaces`, `api_keys`, `memories`, `memory_chunks`, `usage_daily`, `api_audit_log` using `current_workspace()` from JWT claims.
- Membership-hardened RLS in `infra/sql/008_membership_rls.sql`: select/modify allowed if service_role or membership via `workspace_members`; similar for api_keys, memories, memory_chunks, usage_daily, api_audit_log; inserts/deletes constrained.
- Invites policies in `infra/sql/015_invites.sql`: select for members, manage for owners; strengthened `workspace_members` policies for owner-managed roles.

## RPCs / Functions
- Search RPCs (`002_rpc.sql`): `match_chunks_vector(...) returns (chunk_id, memory_id, chunk_index, chunk_text, score)` using vector distance; `match_chunks_text(...)` uses full-text `ts_rank_cd`.
- Usage RPC (`003_usage_rpc.sql`): `bump_usage(workspace_id, day, writes, reads, embeds)` upserts totals returning row.
- Workspace RPC (`009_workspace_rpc.sql`): `create_workspace(p_name)` security definer; inserts workspace and owner membership.
- API key RPCs (`011_api_key_rpcs.sql`): `get_api_key_salt()`, `create_api_key(p_name, p_workspace_id) returns plaintext once plus masked fields`, `list_api_keys(p_workspace_id)`, `revoke_api_key(p_key_id)`.
- Activation metrics (`014_activation.sql`): `activation_counts(p_workspace_id, p_days)` aggregation over product_events.
- Invites RPCs (`015_invites.sql`): `create_invite`, `revoke_invite`, `accept_invite`, `update_member_role`, `remove_member` with owner checks.

## Migration Order Summary
1. `001_init.sql` — base schema, indexes.
2. `002_rpc.sql` — search RPCs.
3. `003_usage.sql` & `003_usage_rpc.sql` — usage table helper.
4. `004_workspace_plan.sql` — add plan column/check.
5. `005_api_audit_log.sql` — audit table.
6. `006_rls.sql` — enable RLS baseline.
7. `007_current_workspace_patch.sql` — patch current_workspace (ref).
8. `008_membership_rls.sql` — membership-based RLS & `workspace_members`.
9. `009_workspace_rpc.sql` — secure workspace creation.
10. `010_api_keys_mask.sql` — mask key fields (ref).
11. `011_api_key_rpcs.sql` — API key RPCs and `app_settings`.
12. `012_billing.sql` — billing columns/indexes.
13. `013_events.sql` — product_events table.
14. `014_activation.sql` — activation_counts RPC.
15. `015_invites.sql` — invites table/RLS/RPCs.
16. `016_webhook_events.sql` — stripe_webhook_events table.
17. `verify_rls.sql` — RLS verification queries (optional).
