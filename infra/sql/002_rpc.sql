-- RPC functions for vector and text search

create or replace function match_chunks_vector(
  p_workspace_id uuid,
  p_user_id text,
  p_namespace text,
  p_query_embedding vector,
  p_match_count int,
  p_metadata jsonb default null,
  p_start_time timestamptz default null,
  p_end_time timestamptz default null
) returns table (
  chunk_id uuid,
  memory_id uuid,
  chunk_index int,
  chunk_text text,
  score float8
)
stable
language sql
as $$
  select
    mc.id as chunk_id,
    mc.memory_id,
    mc.chunk_index,
    mc.chunk_text,
    1 - (mc.embedding <-> p_query_embedding) as score
  from memory_chunks mc
  join memories m on m.id = mc.memory_id and m.workspace_id = mc.workspace_id
  where mc.workspace_id = p_workspace_id
    and mc.user_id = p_user_id
    and mc.namespace = p_namespace
    and (p_metadata is null or m.metadata @> p_metadata)
    and (p_start_time is null or mc.created_at >= p_start_time)
    and (p_end_time is null or mc.created_at <= p_end_time)
  order by mc.embedding <-> p_query_embedding
  limit p_match_count;
$$;

create or replace function match_chunks_text(
  p_workspace_id uuid,
  p_user_id text,
  p_namespace text,
  p_query text,
  p_match_count int,
  p_metadata jsonb default null,
  p_start_time timestamptz default null,
  p_end_time timestamptz default null
) returns table (
  chunk_id uuid,
  memory_id uuid,
  chunk_index int,
  chunk_text text,
  score float8
)
stable
language sql
as $$
  with tsquery as (
    select websearch_to_tsquery('english', p_query) as q
  )
  select
    mc.id as chunk_id,
    mc.memory_id,
    mc.chunk_index,
    mc.chunk_text,
    ts_rank_cd(mc.tsv, tsq.q) as score
  from memory_chunks mc
  join memories m on m.id = mc.memory_id and m.workspace_id = mc.workspace_id
  cross join tsquery tsq
  where mc.workspace_id = p_workspace_id
    and mc.user_id = p_user_id
    and mc.namespace = p_namespace
    and (p_metadata is null or m.metadata @> p_metadata)
    and (p_start_time is null or mc.created_at >= p_start_time)
    and (p_end_time is null or mc.created_at <= p_end_time)
    and mc.tsv @@ tsq.q
  order by ts_rank_cd(mc.tsv, tsq.q) desc
  limit p_match_count;
$$;
