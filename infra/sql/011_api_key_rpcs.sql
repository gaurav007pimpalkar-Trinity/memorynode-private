-- API key RPCs (RLS-safe, membership validated)

-- Settings table to hold API key salt (shared by RPC + worker fallback)
create table if not exists app_settings (
  id boolean primary key default true,
  api_key_salt text not null default ''
);
insert into app_settings (id, api_key_salt)
values (true, '')
on conflict (id) do nothing;

create or replace function get_api_key_salt() returns text
language sql
stable
as $$
  select api_key_salt from app_settings limit 1;
$$;

create or replace function create_api_key(p_name text, p_workspace_id uuid default null)
returns table (
  api_key_id uuid,
  api_key text,
  key_prefix text,
  key_last4 text,
  name text,
  workspace_id uuid,
  created_at timestamptz,
  revoked_at timestamptz
)
security definer
set search_path = public
language plpgsql
as $$
declare
  uid uuid;
  ws uuid;
  raw text;
  salt text;
  hash text;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Name required';
  end if;

  ws := coalesce(p_workspace_id, current_workspace());
  if ws is null then
    raise exception 'Workspace required';
  end if;

  if not exists (select 1 from workspace_members m where m.workspace_id = ws and m.user_id = uid) then
    raise exception 'Not a member of workspace %', ws;
  end if;

  raw := 'mn_live_' || encode(gen_random_bytes(32), 'hex');
  salt := coalesce(get_api_key_salt(), '');
  hash := encode(digest(salt || raw, 'sha256'), 'hex');

  insert into api_keys (workspace_id, name, key_hash, key_prefix, key_last4)
  values (ws, p_name, hash, split_part(raw, '_', 1) || '_' || split_part(raw, '_', 2), right(raw, 4))
  returning id, name, workspace_id, created_at, revoked_at, key_prefix, key_last4
  into api_key_id, name, workspace_id, created_at, revoked_at, key_prefix, key_last4;

  api_key := raw;
  return next;
end;
$$;

create or replace function list_api_keys(p_workspace_id uuid)
returns table (
  id uuid,
  workspace_id uuid,
  name text,
  created_at timestamptz,
  revoked_at timestamptz,
  key_prefix text,
  key_last4 text
)
security definer
set search_path = public
language sql
as $$
  select id, workspace_id, name, created_at, revoked_at, key_prefix, key_last4
  from api_keys
  where workspace_id = p_workspace_id
    and (
      auth.role() = 'service_role'
      or exists (select 1 from workspace_members m where m.workspace_id = api_keys.workspace_id and m.user_id = auth.uid())
    )
  order by created_at desc;
$$;

create or replace function revoke_api_key(p_key_id uuid)
returns table (revoked boolean)
security definer
set search_path = public
language plpgsql
as $$
declare
  ws uuid;
begin
  select workspace_id into ws from api_keys where id = p_key_id;
  if ws is null then
    raise exception 'Key not found';
  end if;
  if auth.role() <> 'service_role' and not exists (
    select 1 from workspace_members m where m.workspace_id = ws and m.user_id = auth.uid()
  ) then
    raise exception 'Not authorized to revoke key';
  end if;
  update api_keys set revoked_at = now() where id = p_key_id;
  revoked := true;
  return next;
end;
$$;
