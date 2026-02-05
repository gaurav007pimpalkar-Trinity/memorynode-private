-- Usage accounting helper

create or replace function bump_usage(
  p_workspace_id uuid,
  p_day date,
  p_writes int,
  p_reads int,
  p_embeds int
) returns usage_daily
language sql
volatile
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
    writes = usage_daily.writes + coalesce(excluded.writes, 0),
    reads  = usage_daily.reads  + coalesce(excluded.reads, 0),
    embeds = usage_daily.embeds + coalesce(excluded.embeds, 0)
  returning *;
$$;
