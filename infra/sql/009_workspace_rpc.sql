-- Secure workspace creation via RPC with automatic membership

-- RLS for workspace_members
do $$
declare
  pol record;
begin
  alter table if exists workspace_members enable row level security;

  for pol in select policyname from pg_policies where tablename = 'workspace_members'
  loop
    execute format('drop policy if exists %I on workspace_members', pol.policyname);
  end loop;

  create policy workspace_members_select on workspace_members
    for select using (auth.role() = 'service_role' or user_id = auth.uid());

  create policy workspace_members_insert on workspace_members
    for insert with check (auth.role() = 'service_role' or user_id = auth.uid());

  create policy workspace_members_delete on workspace_members
    for delete using (auth.role() = 'service_role' or user_id = auth.uid());
end $$;

-- RPC to create workspace and membership atomically
create or replace function create_workspace(p_name text)
returns table (workspace_id uuid, name text)
security definer
set search_path = public
language plpgsql
as $$
declare
  uid uuid;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Workspace name required';
  end if;

  insert into workspaces(name)
  values (p_name)
  returning id, name into workspace_id, name;

  insert into workspace_members(workspace_id, user_id, role)
  values (workspace_id, uid, 'owner')
  on conflict (workspace_id, user_id) do update set role = excluded.role;

  return;
end;
$$;
