-- PLAN §6 trial representation: workspace trial flag + expiry (PlanId stays on workspace.plan until indie/studio/team migration).

alter table workspaces
  add column if not exists trial boolean not null default false,
  add column if not exists trial_expires_at timestamptz null;

comment on column workspaces.trial is 'Time-boxed trial indicator (trial PlanId stays indie until card).';
comment on column workspaces.trial_expires_at is 'When trial access ends for policy enforcement.';

-- Postgres rejects `CREATE OR REPLACE` when the RETURNS TABLE (...) shape changes vs 049_request_path_rls_first.sql (added trial columns).
drop function if exists public.authenticate_api_key(text);

create function authenticate_api_key(p_key_hash text)
returns table (
  api_key_id uuid,
  workspace_id uuid,
  key_created_at timestamptz,
  plan text,
  plan_status text,
  trial boolean,
  trial_expires_at timestamptz
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
    w.plan_status,
    w.trial,
    w.trial_expires_at
  from api_keys k
  join workspaces w on w.id = k.workspace_id
  where k.key_hash = p_key_hash
    and k.revoked_at is null
  limit 1;
$$;

revoke all on function authenticate_api_key(text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function authenticate_api_key(text) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function authenticate_api_key(text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function authenticate_api_key(text) to service_role';
  end if;
end$$;
