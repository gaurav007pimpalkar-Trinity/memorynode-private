-- Track C: Request-path least privilege hardening.
-- 1) Close workspace_members self-enrollment gap.
-- 2) Add request-path auth RPCs so API-key verification does not require service-role table reads.
-- 3) Force RLS on core tenant tables and allow scoped JWT workspace claims.

create or replace function current_workspace_id()
returns uuid
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
  if jwt ? 'user_metadata' and (jwt -> 'user_metadata') ? 'workspace_id' then
    return (jwt -> 'user_metadata' ->> 'workspace_id')::uuid;
  end if;
  if jwt ? 'app_metadata' and (jwt -> 'app_metadata') ? 'workspace_id' then
    return (jwt -> 'app_metadata' ->> 'workspace_id')::uuid;
  end if;
  return null;
end;
$$;

create or replace function is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from workspace_members m
    where m.workspace_id = p_workspace_id
      and (
        m.user_id = auth.uid()
        or p_workspace_id = current_workspace_id()
      )
  );
$$;

do $$
begin
  drop policy if exists workspace_members_self_insert on workspace_members;
  create policy workspace_members_self_insert on workspace_members
    for insert with check (
      auth.role() = 'service_role'
      or workspace_is_owner(workspace_id)
    );
end$$;

do $$
begin
  alter table if exists memories force row level security;
  alter table if exists memory_chunks force row level security;
  alter table if exists workspaces force row level security;
  alter table if exists api_keys force row level security;
  alter table if exists payu_transactions force row level security;
  alter table if exists workspace_entitlements force row level security;
  alter table if exists usage_daily force row level security;
  alter table if exists usage_daily_v2 force row level security;
  alter table if exists search_query_history force row level security;
  alter table if exists dashboard_sessions force row level security;
end$$;

do $$
begin
  drop policy if exists memories_all on memories;
  drop policy if exists memories_select on memories;
  drop policy if exists memory_chunks_all on memory_chunks;
  drop policy if exists memory_chunks_select on memory_chunks;
  drop policy if exists workspaces_all on workspaces;
  drop policy if exists workspaces_select on workspaces;
  drop policy if exists api_keys_all on api_keys;
  drop policy if exists api_keys_select on api_keys;
  drop policy if exists payu_transactions_all on payu_transactions;
  drop policy if exists payu_transactions_select on payu_transactions;
  drop policy if exists workspace_entitlements_all on workspace_entitlements;
  drop policy if exists workspace_entitlements_select on workspace_entitlements;
  drop policy if exists usage_daily_all on usage_daily;
  drop policy if exists usage_daily_select on usage_daily;
  drop policy if exists usage_daily_v2_select on usage_daily_v2;
  drop policy if exists usage_daily_v2_upsert on usage_daily_v2;
  drop policy if exists search_query_history_select on search_query_history;
  drop policy if exists search_query_history_insert on search_query_history;
  drop policy if exists search_query_history_delete on search_query_history;
  drop policy if exists dashboard_sessions_select on dashboard_sessions;
  drop policy if exists dashboard_sessions_insert on dashboard_sessions;
  drop policy if exists dashboard_sessions_delete on dashboard_sessions;

  create policy memories_select on memories
    for select using (is_workspace_member(workspace_id));
  create policy memories_modify on memories
    for all using (is_workspace_member(workspace_id))
    with check (is_workspace_member(workspace_id));

  create policy memory_chunks_select on memory_chunks
    for select using (is_workspace_member(workspace_id));
  create policy memory_chunks_modify on memory_chunks
    for all using (is_workspace_member(workspace_id))
    with check (is_workspace_member(workspace_id));

  create policy workspaces_select on workspaces
    for select using (
      is_workspace_member(id)
    );
  create policy workspaces_modify on workspaces
    for update using (
      auth.role() = 'service_role'
      or workspace_is_owner(id)
    )
    with check (
      auth.role() = 'service_role'
      or workspace_is_owner(id)
    );

  create policy api_keys_select on api_keys
    for select using (is_workspace_member(workspace_id));
  create policy api_keys_modify on api_keys
    for all using (
      auth.role() = 'service_role'
      or workspace_is_owner(workspace_id)
    )
    with check (
      auth.role() = 'service_role'
      or workspace_is_owner(workspace_id)
    );

  create policy payu_transactions_select on payu_transactions
    for select using (is_workspace_member(workspace_id));
  create policy payu_transactions_modify on payu_transactions
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

  create policy workspace_entitlements_select on workspace_entitlements
    for select using (is_workspace_member(workspace_id));
  create policy workspace_entitlements_modify on workspace_entitlements
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

  create policy usage_daily_select on usage_daily
    for select using (is_workspace_member(workspace_id));
  create policy usage_daily_modify on usage_daily
    for all using (is_workspace_member(workspace_id))
    with check (is_workspace_member(workspace_id));

  create policy usage_daily_v2_select on usage_daily_v2
    for select using (is_workspace_member(workspace_id));
  create policy usage_daily_v2_modify on usage_daily_v2
    for all using (is_workspace_member(workspace_id))
    with check (is_workspace_member(workspace_id));

  create policy search_query_history_select on search_query_history
    for select using (is_workspace_member(workspace_id));
  create policy search_query_history_insert on search_query_history
    for insert with check (is_workspace_member(workspace_id));
  create policy search_query_history_delete on search_query_history
    for delete using (is_workspace_member(workspace_id));

  create policy dashboard_sessions_select on dashboard_sessions
    for select using (is_workspace_member(workspace_id));
  create policy dashboard_sessions_insert on dashboard_sessions
    for insert with check (is_workspace_member(workspace_id));
  create policy dashboard_sessions_delete on dashboard_sessions
    for delete using (is_workspace_member(workspace_id));
end$$;

create or replace function authenticate_api_key(p_key_hash text)
returns table (
  api_key_id uuid,
  workspace_id uuid,
  key_created_at timestamptz,
  plan text,
  plan_status text
)
language sql
security definer
set search_path = public
as $$
  select
    k.id as api_key_id,
    k.workspace_id,
    k.created_at as key_created_at,
    w.plan,
    w.plan_status
  from api_keys k
  join workspaces w on w.id = k.workspace_id
  where k.key_hash = p_key_hash
    and k.revoked_at is null
  limit 1;
$$;

create or replace function touch_api_key_usage(
  p_key_id uuid,
  p_last_used_ip text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update api_keys
  set last_used_at = now(),
      last_used_ip = p_last_used_ip
  where id = p_key_id;
end;
$$;

revoke all on function get_api_key_salt() from public;
revoke all on function authenticate_api_key(text) from public;
revoke all on function touch_api_key_usage(uuid, text) from public;

grant execute on function get_api_key_salt() to anon, authenticated, service_role;
grant execute on function authenticate_api_key(text) to anon, authenticated, service_role;
grant execute on function touch_api_key_usage(uuid, text) to anon, authenticated, service_role;

