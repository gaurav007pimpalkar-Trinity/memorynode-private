-- Workspace-level pruning / hygiene visibility (counts only; marking remains POST /admin/memory-hygiene).

create or replace function public.workspace_pruning_metrics(p_workspace_id uuid)
returns table (
  memories_total bigint,
  memories_marked_duplicate bigint,
  memory_chunks_total bigint
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*)::bigint from public.memories m where m.workspace_id = p_workspace_id) as memories_total,
    (
      select count(*)::bigint
      from public.memories m
      where m.workspace_id = p_workspace_id and m.duplicate_of is not null
    ) as memories_marked_duplicate,
    (select count(*)::bigint from public.memory_chunks mc where mc.workspace_id = p_workspace_id) as memory_chunks_total;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.workspace_pruning_metrics(uuid) to service_role';
  end if;
end$$;
