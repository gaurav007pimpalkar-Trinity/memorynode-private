-- Membership-based RLS hardened against user-editable JWT metadata

-- Workspace membership table (idempotent)
create table if not exists workspace_members (
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx on workspace_members(user_id);

-- Policies now rely on membership (auth.uid()) OR service_role
do $$
declare
  pol record;
begin
  -- Helper to drop if exists
  for pol in
    select policyname, tablename
    from pg_policies
    where tablename in ('workspaces','api_keys','memories','memory_chunks','usage_daily','api_audit_log')
  loop
    execute format('drop policy if exists %I on %I', pol.policyname, pol.tablename);
  end loop;

  -- Workspaces
  alter table if exists workspaces enable row level security;
  create policy workspaces_select on workspaces
    for select using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = workspaces.id and m.user_id = auth.uid()
      )
    );
  create policy workspaces_all on workspaces
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

  -- API keys
  alter table if exists api_keys enable row level security;
  create policy api_keys_select on api_keys
    for select using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = api_keys.workspace_id and m.user_id = auth.uid()
      )
    );
  create policy api_keys_all on api_keys
    for all using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = api_keys.workspace_id and m.user_id = auth.uid()
      )
    )
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = api_keys.workspace_id and m.user_id = auth.uid()
      )
    );

  -- Memories
  alter table if exists memories enable row level security;
  create policy memories_select on memories
    for select using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = memories.workspace_id and m.user_id = auth.uid()
      )
    );
  create policy memories_all on memories
    for all using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = memories.workspace_id and m.user_id = auth.uid()
      )
    )
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = memories.workspace_id and m.user_id = auth.uid()
      )
    );

  -- Memory chunks
  alter table if exists memory_chunks enable row level security;
  create policy memory_chunks_select on memory_chunks
    for select using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = memory_chunks.workspace_id and m.user_id = auth.uid()
      )
    );
  create policy memory_chunks_all on memory_chunks
    for all using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = memory_chunks.workspace_id and m.user_id = auth.uid()
      )
    )
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = memory_chunks.workspace_id and m.user_id = auth.uid()
      )
    );

  -- Usage daily
  alter table if exists usage_daily enable row level security;
  create policy usage_daily_select on usage_daily
    for select using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = usage_daily.workspace_id and m.user_id = auth.uid()
      )
    );
  create policy usage_daily_all on usage_daily
    for all using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = usage_daily.workspace_id and m.user_id = auth.uid()
      )
    )
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = usage_daily.workspace_id and m.user_id = auth.uid()
      )
    );

  -- API audit log (read-only)
  alter table if exists api_audit_log enable row level security;
  create policy api_audit_log_select on api_audit_log
    for select using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = api_audit_log.workspace_id and m.user_id = auth.uid()
      )
    );
end $$;
