-- Phase 3 prep: move list memories read path behind workspace-scoped RPC.

create or replace function public.list_memories_scoped(
  p_workspace_id uuid,
  p_page integer default 1,
  p_page_size integer default 20,
  p_namespace text default null,
  p_user_id text default null,
  p_memory_type text default null,
  p_metadata jsonb default null,
  p_start_time timestamptz default null,
  p_end_time timestamptz default null
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
  source_memory_id uuid,
  total_count bigint
)
language sql
security definer
set search_path = public
as $$
  with filtered as (
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
      and m.duplicate_of is null
      and (p_namespace is null or m.namespace = p_namespace)
      and (p_user_id is null or m.user_id = p_user_id)
      and (p_memory_type is null or m.memory_type = p_memory_type)
      and (p_metadata is null or m.metadata @> p_metadata)
      and (p_start_time is null or m.created_at >= p_start_time)
      and (p_end_time is null or m.created_at <= p_end_time)
  )
  select
    f.id,
    f.workspace_id,
    f.user_id,
    f.namespace,
    f.text,
    f.metadata,
    f.created_at,
    f.memory_type,
    f.source_memory_id,
    count(*) over () as total_count
  from filtered f
  order by f.created_at desc, f.id desc
  limit greatest(1, p_page_size + 1)
  offset greatest(0, (greatest(1, p_page) - 1) * greatest(1, p_page_size));
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.list_memories_scoped(
      uuid,
      integer,
      integer,
      text,
      text,
      text,
      jsonb,
      timestamptz,
      timestamptz
    ) to service_role';
  end if;
end$$;
