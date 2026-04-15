-- 036_bump_usage_if_within_cap_reapply_hotfix.sql
-- Reapply hotfix for mixed histories where 035 was marked applied before final SQL.
-- This forward migration guarantees the runtime RPC body has unambiguous references.

set search_path = public;

create or replace function public.bump_usage_if_within_cap(
  p_workspace_id uuid,
  p_day date,
  p_writes int,
  p_reads int,
  p_embeds int,
  p_embed_tokens int,
  p_extraction_calls int,
  p_writes_cap int,
  p_reads_cap int,
  p_embeds_cap int,
  p_embed_tokens_cap int,
  p_extraction_calls_cap int
)
returns table (
  workspace_id uuid,
  day date,
  writes int,
  reads int,
  embeds int,
  extraction_calls int,
  embed_tokens_used int,
  exceeded boolean,
  limit_name text
)
language plpgsql
security definer
volatile
as $$
declare
  v_row usage_daily%rowtype;
  v_writes int;
  v_reads int;
  v_embeds int;
  v_embed_tokens int;
  v_extraction_calls int;
begin
  p_writes := coalesce(p_writes, 0);
  p_reads := coalesce(p_reads, 0);
  p_embeds := coalesce(p_embeds, 0);
  p_embed_tokens := coalesce(p_embed_tokens, 0);
  p_extraction_calls := coalesce(p_extraction_calls, 0);
  p_writes_cap := coalesce(p_writes_cap, 0);
  p_reads_cap := coalesce(p_reads_cap, 0);
  p_embeds_cap := coalesce(p_embeds_cap, 0);
  p_embed_tokens_cap := coalesce(p_embed_tokens_cap, 0);
  p_extraction_calls_cap := coalesce(p_extraction_calls_cap, 0);

  select * into v_row
  from usage_daily u0
  where u0.workspace_id = p_workspace_id and u0.day = p_day
  for update;

  if not found then
    v_writes := 0;
    v_reads := 0;
    v_embeds := 0;
    v_embed_tokens := 0;
    v_extraction_calls := 0;
  else
    v_writes := v_row.writes;
    v_reads := v_row.reads;
    v_embeds := v_row.embeds;
    v_embed_tokens := coalesce(v_row.embed_tokens_used, 0);
    v_extraction_calls := coalesce(v_row.extraction_calls, 0);
  end if;

  if (v_writes + p_writes) > p_writes_cap then
    return query select
      p_workspace_id, p_day,
      v_writes, v_reads, v_embeds,
      v_extraction_calls, v_embed_tokens,
      true::boolean, 'writes'::text;
    return;
  end if;
  if (v_reads + p_reads) > p_reads_cap then
    return query select
      p_workspace_id, p_day,
      v_writes, v_reads, v_embeds,
      v_extraction_calls, v_embed_tokens,
      true::boolean, 'reads'::text;
    return;
  end if;
  if (v_embeds + p_embeds) > p_embeds_cap then
    return query select
      p_workspace_id, p_day,
      v_writes, v_reads, v_embeds,
      v_extraction_calls, v_embed_tokens,
      true::boolean, 'embeds'::text;
    return;
  end if;
  if (v_embed_tokens + p_embed_tokens) > p_embed_tokens_cap then
    return query select
      p_workspace_id, p_day,
      v_writes, v_reads, v_embeds,
      v_extraction_calls, v_embed_tokens,
      true::boolean, 'embed_tokens'::text;
    return;
  end if;
  if (v_extraction_calls + p_extraction_calls) > p_extraction_calls_cap then
    return query select
      p_workspace_id, p_day,
      v_writes, v_reads, v_embeds,
      v_extraction_calls, v_embed_tokens,
      true::boolean, 'extraction_calls'::text;
    return;
  end if;

  insert into usage_daily (workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens_used)
  values (
    p_workspace_id,
    p_day,
    coalesce(p_writes, 0),
    coalesce(p_reads, 0),
    coalesce(p_embeds, 0),
    coalesce(p_extraction_calls, 0),
    coalesce(p_embed_tokens, 0)
  )
  on conflict (workspace_id, day)
  do update set
    writes = usage_daily.writes + coalesce(excluded.writes, 0),
    reads = usage_daily.reads + coalesce(excluded.reads, 0),
    embeds = usage_daily.embeds + coalesce(excluded.embeds, 0),
    extraction_calls = usage_daily.extraction_calls + coalesce(excluded.extraction_calls, 0),
    embed_tokens_used = usage_daily.embed_tokens_used + coalesce(excluded.embed_tokens_used, 0);

  return query
  select
    u.workspace_id,
    u.day,
    u.writes,
    u.reads,
    u.embeds,
    u.extraction_calls,
    u.embed_tokens_used,
    false::boolean,
    null::text
  from usage_daily u
  where u.workspace_id = p_workspace_id and u.day = p_day;
end;
$$;
