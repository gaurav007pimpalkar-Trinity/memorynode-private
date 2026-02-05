-- 015_invites.sql - workspace invites and owner-managed roles

-- Invites table
create table if not exists workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'member',
  token text not null unique,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz
);

alter table workspace_invites
  add constraint workspace_invites_role_check
  check (role in ('member','admin','owner'));

create index if not exists workspace_invites_workspace_idx on workspace_invites (workspace_id, created_at desc);
create index if not exists workspace_invites_email_idx on workspace_invites (lower(email), workspace_id);
create unique index if not exists workspace_invites_unique_pending
  on workspace_invites (workspace_id, lower(email))
  where revoked_at is null and accepted_at is null;

-- RLS for invites (visible to members, managed by owners)
alter table if exists workspace_invites enable row level security;
do $$
declare
  pol record;
begin
  for pol in select policyname from pg_policies where tablename = 'workspace_invites' loop
    execute format('drop policy if exists %I on workspace_invites', pol.policyname);
  end loop;

  create policy workspace_invites_select on workspace_invites
    for select using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = workspace_invites.workspace_id
          and m.user_id = auth.uid()
      )
    );

  create policy workspace_invites_manage on workspace_invites
    for all using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = workspace_invites.workspace_id
          and m.user_id = auth.uid()
          and m.role = 'owner'
      )
    )
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = workspace_invites.workspace_id
          and m.user_id = auth.uid()
          and m.role = 'owner'
      )
    );
end$$;

-- Strengthen workspace_members policies to allow owners to manage members
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
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = workspace_members.workspace_id
          and m.user_id = auth.uid()
      )
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
      or exists (
        select 1 from workspace_members owners
        where owners.workspace_id = workspace_members.workspace_id
          and owners.user_id = auth.uid()
          and owners.role = 'owner'
      )
    )
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members owners
        where owners.workspace_id = workspace_members.workspace_id
          and owners.user_id = auth.uid()
          and owners.role = 'owner'
      )
    );
end$$;

-- RPC: create invite (owner only)
create or replace function create_invite(p_workspace_id uuid, p_email text, p_role text default 'member')
returns table (id uuid, workspace_id uuid, email text, role text, token text, expires_at timestamptz)
security definer
set search_path = public
language plpgsql
as $$
declare
  caller uuid;
  ws uuid;
  tok text;
begin
  caller := auth.uid();
  if caller is null then
    raise exception 'Not authenticated';
  end if;
  ws := coalesce(p_workspace_id, current_workspace());
  if ws is null then
    raise exception 'Workspace required';
  end if;
  if not exists (
    select 1 from workspace_members m
    where m.workspace_id = ws and m.user_id = caller and m.role = 'owner'
  ) then
    raise exception 'Only owners can invite';
  end if;
  if coalesce(trim(p_email), '') = '' then
    raise exception 'Email required';
  end if;
  if coalesce(p_role, '') not in ('member','admin','owner') then
    raise exception 'Invalid role';
  end if;
  tok := encode(gen_random_bytes(24), 'hex');
  insert into workspace_invites(workspace_id, email, role, token, created_by)
  values (ws, trim(p_email), p_role, tok, caller)
  returning id, workspace_id, email, role, token, expires_at into id, workspace_id, email, role, token, expires_at;
  return next;
end;
$$;

-- RPC: revoke invite (owner only)
create or replace function revoke_invite(p_invite_id uuid)
returns table (revoked boolean)
security definer
set search_path = public
language plpgsql
as $$
declare
  caller uuid;
  ws uuid;
begin
  caller := auth.uid();
  if caller is null then
    raise exception 'Not authenticated';
  end if;
  select workspace_id into ws from workspace_invites where id = p_invite_id;
  if ws is null then
    raise exception 'Invite not found';
  end if;
  if not exists (
    select 1 from workspace_members m
    where m.workspace_id = ws and m.user_id = caller and m.role = 'owner'
  ) then
    raise exception 'Only owners can revoke invites';
  end if;
  update workspace_invites set revoked_at = now() where id = p_invite_id;
  revoked := true;
  return next;
end;
$$;

-- RPC: accept invite by token
create or replace function accept_invite(p_token text)
returns table (workspace_id uuid, role text)
security definer
set search_path = public
language plpgsql
as $$
declare
  caller uuid;
  inv record;
begin
  caller := auth.uid();
  if caller is null then
    raise exception 'Not authenticated';
  end if;
  select * into inv
  from workspace_invites
  where token = p_token
    and revoked_at is null
    and accepted_at is null
    and expires_at > now()
  limit 1;
  if not found then
    raise exception 'Invite invalid or expired';
  end if;

  insert into workspace_members(workspace_id, user_id, role)
  values (inv.workspace_id, caller, inv.role)
  on conflict (workspace_id, user_id) do update set role = excluded.role;

  update workspace_invites
  set accepted_at = now(), accepted_by = caller
  where id = inv.id;

  workspace_id := inv.workspace_id;
  role := inv.role;
  return next;
end;
$$;

-- RPC: update member role (owner only)
create or replace function update_member_role(p_workspace_id uuid, p_user_id uuid, p_role text)
returns table (updated boolean)
security definer
set search_path = public
language plpgsql
as $$
declare
  caller uuid;
begin
  caller := auth.uid();
  if caller is null then
    raise exception 'Not authenticated';
  end if;
  if coalesce(p_role, '') not in ('member','admin','owner') then
    raise exception 'Invalid role';
  end if;
  if not exists (
    select 1 from workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = caller and m.role = 'owner'
  ) then
    raise exception 'Only owners can update roles';
  end if;
  if not exists (
    select 1 from workspace_members m
    where m.workspace_id = p_workspace_id and m.role = 'owner'
  ) then
    raise exception 'Cannot remove last owner';
  end if;
  update workspace_members
  set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id;
  updated := (sql%rowcount > 0);
  return next;
end;
$$;

-- RPC: remove member (owner only)
create or replace function remove_member(p_workspace_id uuid, p_user_id uuid)
returns table (removed boolean)
security definer
set search_path = public
language plpgsql
as $$
declare
  caller uuid;
begin
  caller := auth.uid();
  if caller is null then
    raise exception 'Not authenticated';
  end if;
  if not exists (
    select 1 from workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = caller and m.role = 'owner'
  ) then
    raise exception 'Only owners can remove members';
  end if;
  if not exists (
    select 1 from workspace_members m where m.workspace_id = p_workspace_id and m.role = 'owner' and m.user_id <> p_user_id
  ) then
    raise exception 'Cannot remove last owner';
  end if;
  delete from workspace_members where workspace_id = p_workspace_id and user_id = p_user_id;
  removed := (sql%rowcount > 0);
  return next;
end;
$$;
