-- Dashboard console overview: aggregate counts for workspace (service_role only; Worker passes workspace from authenticated session).

create or replace function public.dashboard_console_overview_stats(
  p_workspace_id uuid,
  p_memories_since timestamptz,
  p_usage_day_min date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'documents',
    coalesce(
      (
        select count(*)::bigint
        from memories m
        where m.workspace_id = p_workspace_id
          and (p_memories_since is null or m.created_at >= p_memories_since)
      ),
      0
    ),
    'memories',
    coalesce(
      (
        select count(*)::bigint
        from memory_chunks mc
        where mc.workspace_id = p_workspace_id
          and (p_memories_since is null or mc.created_at >= p_memories_since)
      ),
      0
    ),
    'search_requests',
    coalesce(
      (
        select sum(u.reads)::bigint
        from usage_daily u
        where u.workspace_id = p_workspace_id
          and (p_usage_day_min is null or u.day >= p_usage_day_min)
      ),
      0
    ),
    'container_tags',
    coalesce(
      (
        select count(distinct x.tag)::bigint
        from (
          select nullif(trim(m.metadata ->> 'container_tag'), '') as tag
          from memories m
          where m.workspace_id = p_workspace_id
            and (p_memories_since is null or m.created_at >= p_memories_since)
          union all
          select nullif(trim(m.metadata ->> 'container'), '') as tag
          from memories m
          where m.workspace_id = p_workspace_id
            and (p_memories_since is null or m.created_at >= p_memories_since)
        ) x
        where x.tag is not null
      ),
      0
    )
  );
$$;

revoke all on function public.dashboard_console_overview_stats(uuid, timestamptz, date) from public;

-- Supabase defines role `service_role`; vanilla Postgres (e.g. CI drift DB) does not.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.dashboard_console_overview_stats(uuid, timestamptz, date) to service_role';
  end if;
end $$;
