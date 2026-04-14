-- 031_workspace_members_rls_recursion_fix.sql
-- Fix infinite recursion in workspace_members RLS policies introduced by self-referential EXISTS checks.

create or replace function workspace_is_owner(p_workspace_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;

do $$
declare
  pol record;
begin
  for pol in select policyname from pg_policies where tablename = 'workspace_members' loop
    execute format('drop policy if exists %I on workspace_members', pol.policyname);
  end loop;

  create policy workspace_members_select on workspace_members
    for select using (
      auth.role() = 'service_role'
      or user_id = auth.uid()
      or workspace_is_owner(workspace_id)
    );

  create policy workspace_members_self_insert on workspace_members
    for insert with check (
      auth.role() = 'service_role'
      or user_id = auth.uid()
    );

  create policy workspace_members_self_delete on workspace_members
    for delete using (
      auth.role() = 'service_role'
      or user_id = auth.uid()
    );

  create policy workspace_members_owner_manage on workspace_members
    for all using (
      auth.role() = 'service_role'
      or workspace_is_owner(workspace_id)
    )
    with check (
      auth.role() = 'service_role'
      or workspace_is_owner(workspace_id)
    );
end$$;
