-- Workspace-scoped memory RPCs (Phase 2 tenant isolation hardening)
-- Purpose:
-- 1) Centralize sensitive memory read/delete operations in DB layer.
-- 2) Keep workspace predicate enforced at function boundary.

create or replace function public.get_memory_scoped(
  p_workspace_id uuid,
  p_memory_id uuid
)
returns table (
  id uuid,
  workspace_id uuid,
  user_id text,
  namespace text,
  text text,
  metadata jsonb,
  created_at timestamptz,
  memory_type text,
  source_memory_id uuid
)
language sql
security definer
set search_path = public
as $$
  select
    m.id,
    m.workspace_id,
    m.user_id,
    m.namespace,
    m.text,
    m.metadata,
    m.created_at,
    m.memory_type,
    m.source_memory_id
  from public.memories m
  where m.workspace_id = p_workspace_id
    and m.id = p_memory_id
  limit 1;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.get_memory_scoped(uuid, uuid) to service_role';
  end if;
end$$;

create or replace function public.delete_memory_scoped(
  p_workspace_id uuid,
  p_memory_id uuid
)
returns table (
  deleted boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_count integer := 0;
begin
  delete from public.memory_chunks
  where workspace_id = p_workspace_id
    and memory_id = p_memory_id;

  delete from public.memories
  where workspace_id = p_workspace_id
    and id = p_memory_id;

  get diagnostics v_deleted_count = row_count;

  return query select (v_deleted_count > 0);
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.delete_memory_scoped(uuid, uuid) to service_role';
  end if;
end$$;
