-- 032_small_team_member_caps.sql
-- Enforce small-team seat caps:
-- - Solo plans: 1 member
-- - Team plans: up to 10 members
-- Legacy scale_plus keeps a wider cap for backward compatibility.

set search_path = public;

create or replace function resolve_workspace_member_cap(p_workspace_id uuid)
returns int
language plpgsql
security definer
stable
as $$
declare
  v_plan text;
begin
  select we.plan_code
    into v_plan
  from workspace_entitlements we
  where we.workspace_id = p_workspace_id
    and we.status = 'active'
    and (we.expires_at is null or we.expires_at > now())
  order by we.starts_at desc
  limit 1;

  if v_plan is null then
    select w.plan into v_plan from workspaces w where w.id = p_workspace_id;
  end if;

  v_plan := lower(coalesce(v_plan, 'free'));
  if v_plan in ('free', 'pro', 'launch', 'build', 'solo') then
    return 1;
  end if;
  if v_plan in ('team', 'deploy', 'scale') then
    return 10;
  end if;
  if v_plan = 'scale_plus' then
    return 25;
  end if;
  return 10;
end;
$$;

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
  member_cap int;
  seat_count int;
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

  member_cap := resolve_workspace_member_cap(ws);
  select (
      (select count(*) from workspace_members m where m.workspace_id = ws) +
      (select count(*) from workspace_invites i where i.workspace_id = ws and i.accepted_at is null and i.revoked_at is null)
    )
    into seat_count;
  if seat_count >= member_cap then
    raise exception 'Seat cap reached (% seats) for current plan. Upgrade to add more members.', member_cap;
  end if;

  tok := encode(gen_random_bytes(24), 'hex');
  insert into workspace_invites(workspace_id, email, role, token, created_by)
  values (ws, trim(p_email), p_role, tok, caller)
  returning id, workspace_id, email, role, token, expires_at into id, workspace_id, email, role, token, expires_at;
  return next;
end;
$$;

create or replace function accept_invite(p_token text)
returns table (workspace_id uuid, role text)
security definer
set search_path = public
language plpgsql
as $$
declare
  caller uuid;
  inv record;
  member_cap int;
  member_count int;
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

  member_cap := resolve_workspace_member_cap(inv.workspace_id);
  select count(*) into member_count from workspace_members m where m.workspace_id = inv.workspace_id;
  if member_count >= member_cap then
    raise exception 'Seat cap reached (% seats) for current plan. Upgrade to add more members.', member_cap;
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
