-- Phase 2: Recency-based ranking for memory chunks.
-- Adds last_accessed_at, backfill, index, and decay multiplier in search RPCs.
-- No triggers, no background jobs, no new endpoints.

--------------------------------------------------------------------------------
-- 1. Schema: last_accessed_at on memory_chunks
--------------------------------------------------------------------------------

alter table memory_chunks
  add column if not exists last_accessed_at timestamptz null;

--------------------------------------------------------------------------------
-- 2. Backfill existing rows (NULL-safe)
--------------------------------------------------------------------------------

update memory_chunks
set last_accessed_at = created_at
where last_accessed_at is null;

--------------------------------------------------------------------------------
-- 3. Index for workspace + recency
--------------------------------------------------------------------------------

create index if not exists memory_chunks_workspace_last_accessed_idx
  on memory_chunks (workspace_id, last_accessed_at desc nulls last);

--------------------------------------------------------------------------------
-- 4. Vector search RPC with decay: final_score = similarity_score * decay_multiplier
--    decay_multiplier = exp(-ln(2) * days_since_access / 30), half-life 30 days
--    days_since_access from COALESCE(last_accessed_at, created_at)
--------------------------------------------------------------------------------

create or replace function match_chunks_vector(
  p_workspace_id uuid,
  p_user_id text,
  p_namespace text,
  p_query_embedding vector,
  p_match_count int,
  p_metadata jsonb default null,
  p_start_time timestamptz default null,
  p_end_time timestamptz default null,
  p_memory_types text[] default null,
  p_filter_mode text default 'and'
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
  with base as (
    select
      mc.id as chunk_id,
      mc.memory_id,
      mc.chunk_index,
      mc.chunk_text,
      1 - (mc.embedding <-> p_query_embedding) as raw_score,
      exp(-ln(2) * extract(epoch from (now() - coalesce(mc.last_accessed_at, mc.created_at))) / 86400.0 / 30) as decay_multiplier
    from memory_chunks mc
    join memories m on m.id = mc.memory_id and m.workspace_id = mc.workspace_id
    where mc.workspace_id = p_workspace_id
      and mc.user_id = p_user_id
      and mc.namespace = p_namespace
      and m.duplicate_of is null
      and (p_memory_types is null or m.memory_type = any(p_memory_types))
      and (
        p_metadata is null
        or (
          case when p_filter_mode = 'or' then
            exists (
              select 1 from jsonb_each(p_metadata) kv
              where m.metadata @> jsonb_build_object(kv.key, kv.value)
            )
          else
            m.metadata @> p_metadata
          end
        )
      )
      and (p_start_time is null or mc.created_at >= p_start_time)
      and (p_end_time is null or mc.created_at <= p_end_time)
  )
  select
    base.chunk_id,
    base.memory_id,
    base.chunk_index,
    base.chunk_text,
    (base.raw_score * base.decay_multiplier) as score
  from base
  order by score desc
  limit p_match_count;
$$;

--------------------------------------------------------------------------------
-- 5. Text search RPC with same decay
--------------------------------------------------------------------------------

create or replace function match_chunks_text(
  p_workspace_id uuid,
  p_user_id text,
  p_namespace text,
  p_query text,
  p_match_count int,
  p_metadata jsonb default null,
  p_start_time timestamptz default null,
  p_end_time timestamptz default null,
  p_memory_types text[] default null,
  p_filter_mode text default 'and'
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
  ),
  base as (
    select
      mc.id as chunk_id,
      mc.memory_id,
      mc.chunk_index,
      mc.chunk_text,
      ts_rank_cd(mc.tsv, tsq.q) as raw_score,
      exp(-ln(2) * extract(epoch from (now() - coalesce(mc.last_accessed_at, mc.created_at))) / 86400.0 / 30) as decay_multiplier
    from memory_chunks mc
    join memories m on m.id = mc.memory_id and m.workspace_id = mc.workspace_id
    cross join tsquery tsq
    where mc.workspace_id = p_workspace_id
      and mc.user_id = p_user_id
      and mc.namespace = p_namespace
      and m.duplicate_of is null
      and (p_memory_types is null or m.memory_type = any(p_memory_types))
      and (
        p_metadata is null
        or (
          case when p_filter_mode = 'or' then
            exists (
              select 1 from jsonb_each(p_metadata) kv
              where m.metadata @> jsonb_build_object(kv.key, kv.value)
            )
          else
            m.metadata @> p_metadata
          end
        )
      )
      and (p_start_time is null or mc.created_at >= p_start_time)
      and (p_end_time is null or mc.created_at <= p_end_time)
      and mc.tsv @@ tsq.q
  )
  select
    base.chunk_id,
    base.memory_id,
    base.chunk_index,
    base.chunk_text,
    (base.raw_score * base.decay_multiplier) as score
  from base
  order by score desc
  limit p_match_count;
$$;
