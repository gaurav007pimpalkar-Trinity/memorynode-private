-- Usage bump RPC to keep schema cache consistent
set search_path = public;

create or replace function public.bump_usage(
  p_workspace_id uuid,
  p_day date,
  p_writes int,
  p_reads int,
  p_embeds int
) returns table (
  workspace_id uuid,
  day date,
  writes int,
  reads int,
  embeds int
)
security definer
volatile
language sql
as $$
  insert into usage_daily (workspace_id, day, writes, reads, embeds)
  values (
    p_workspace_id,
    p_day,
    coalesce(p_writes, 0),
    coalesce(p_reads, 0),
    coalesce(p_embeds, 0)
  )
  on conflict (workspace_id, day)
  do update set
    writes = usage_daily.writes + excluded.writes,
    reads  = usage_daily.reads  + excluded.reads,
    embeds = usage_daily.embeds + excluded.embeds
  returning workspace_id, day, writes, reads, embeds;
$$;
