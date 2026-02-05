-- Enable row level security and workspace-scoped policies

-- Helper to pull workspace_id from JWT claims (used by Supabase)
create or replace function current_workspace() returns uuid
language plpgsql
stable
as $$
declare
  jwt jsonb;
begin
  jwt := auth.jwt();
  if jwt ? 'workspace_id' then
    return (jwt ->> 'workspace_id')::uuid;
  end if;
  return null;
end;
$$;

-- Enables RLS and recreates policies in an idempotent way
do $$
begin
  -- workspaces
  alter table if exists workspaces enable row level security;
  if exists (
  select 1
  from pg_policies
  where schemaname = 'public'
    and tablename = 'workspaces'
    and policyname = 'workspaces_sel'
) then
    drop policy workspaces_sel on workspaces;
  end if;
  if exists (select 1 from pg_policies where policyname = 'workspaces_mod') then
    drop policy workspaces_mod on workspaces;
  end if;
  create policy workspaces_sel on workspaces
    for select using (auth.role() = 'service_role' or id = current_workspace());
  create policy workspaces_mod on workspaces
    for all using (auth.role() = 'service_role' or id = current_workspace())
    with check (auth.role() = 'service_role' or id = current_workspace());

  -- api_keys
  alter table if exists api_keys enable row level security;
  if exists (select 1 from pg_policies where policyname = 'api_keys_sel') then
    drop policy api_keys_sel on api_keys;
  end if;
  if exists (select 1 from pg_policies where policyname = 'api_keys_mod') then
    drop policy api_keys_mod on api_keys;
  end if;
  create policy api_keys_sel on api_keys
    for select using (auth.role() = 'service_role' or workspace_id = current_workspace());
  create policy api_keys_mod on api_keys
    for all using (auth.role() = 'service_role' or workspace_id = current_workspace())
    with check (auth.role() = 'service_role' or workspace_id = current_workspace());

  -- memories
  alter table if exists memories enable row level security;
  if exists (select 1 from pg_policies where policyname = 'memories_sel') then
    drop policy memories_sel on memories;
  end if;
  if exists (select 1 from pg_policies where policyname = 'memories_mod') then
    drop policy memories_mod on memories;
  end if;
  create policy memories_sel on memories
    for select using (auth.role() = 'service_role' or workspace_id = current_workspace());
  create policy memories_mod on memories
    for all using (auth.role() = 'service_role' or workspace_id = current_workspace())
    with check (auth.role() = 'service_role' or workspace_id = current_workspace());

  -- memory_chunks
  alter table if exists memory_chunks enable row level security;
  if exists (select 1 from pg_policies where policyname = 'memory_chunks_sel') then
    drop policy memory_chunks_sel on memory_chunks;
  end if;
  if exists (select 1 from pg_policies where policyname = 'memory_chunks_mod') then
    drop policy memory_chunks_mod on memory_chunks;
  end if;
  create policy memory_chunks_sel on memory_chunks
    for select using (auth.role() = 'service_role' or workspace_id = current_workspace());
  create policy memory_chunks_mod on memory_chunks
    for all using (auth.role() = 'service_role' or workspace_id = current_workspace())
    with check (auth.role() = 'service_role' or workspace_id = current_workspace());

  -- usage_daily
  alter table if exists usage_daily enable row level security;
  if exists (select 1 from pg_policies where policyname = 'usage_daily_sel') then
    drop policy usage_daily_sel on usage_daily;
  end if;
  if exists (select 1 from pg_policies where policyname = 'usage_daily_mod') then
    drop policy usage_daily_mod on usage_daily;
  end if;
  create policy usage_daily_sel on usage_daily
    for select using (auth.role() = 'service_role' or workspace_id = current_workspace());
  create policy usage_daily_mod on usage_daily
    for all using (auth.role() = 'service_role' or workspace_id = current_workspace())
    with check (auth.role() = 'service_role' or workspace_id = current_workspace());

  -- api_audit_log (read-only for tenants)
  alter table if exists api_audit_log enable row level security;
  if exists (select 1 from pg_policies where policyname = 'api_audit_log_sel') then
    drop policy api_audit_log_sel on api_audit_log;
  end if;
  create policy api_audit_log_sel on api_audit_log
    for select using (auth.role() = 'service_role' or workspace_id = current_workspace());
end $$;
