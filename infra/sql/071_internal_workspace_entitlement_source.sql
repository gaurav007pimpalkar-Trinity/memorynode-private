-- Internal workspace entitlement source (billing remains default)
alter table workspaces
  add column if not exists internal boolean not null default false;

alter table workspaces
  add column if not exists entitlement_source text not null default 'billing';

alter table workspaces
  add column if not exists internal_grant_enabled boolean not null default false;

update workspaces
set internal = coalesce(internal, false)
where internal is null;

update workspaces
set entitlement_source = 'billing'
where entitlement_source is null;

update workspaces
set internal_grant_enabled = false
where internal_grant_enabled is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspaces_entitlement_source_check'
  ) then
    alter table workspaces
      add constraint workspaces_entitlement_source_check
      check (entitlement_source in ('billing', 'internal_grant'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspaces_internal_entitlement_guard_check'
  ) then
    alter table workspaces
      add constraint workspaces_internal_entitlement_guard_check
      check (
        (entitlement_source = 'billing' and internal_grant_enabled = false)
        or (entitlement_source = 'internal_grant' and internal = true)
      );
  end if;
end
$$;

create table if not exists workspace_entitlement_audit (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  changed_by text not null,
  previous_source text null check (previous_source in ('billing', 'internal_grant')),
  new_source text not null check (new_source in ('billing', 'internal_grant')),
  reason text null,
  created_at timestamptz not null default now()
);

create index if not exists workspace_entitlement_audit_workspace_created_idx
  on workspace_entitlement_audit (workspace_id, created_at desc);

create or replace function protect_workspace_entitlement_source_update()
returns trigger
language plpgsql
as $$
begin
  if (new.internal is distinct from old.internal)
    or (new.entitlement_source is distinct from old.entitlement_source)
    or (new.internal_grant_enabled is distinct from old.internal_grant_enabled) then
    raise exception 'workspace entitlement source fields are write-protected';
  end if;
  return new;
end;
$$;

drop trigger if exists tr_protect_workspace_entitlement_source_update on workspaces;
create trigger tr_protect_workspace_entitlement_source_update
before update on workspaces
for each row
execute function protect_workspace_entitlement_source_update();
