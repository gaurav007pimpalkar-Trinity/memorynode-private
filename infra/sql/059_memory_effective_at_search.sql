-- Optional effective_at on memories (non-enterprise temporal: "as of" scheduling + retrieval filter).
-- Supersession continues to use duplicate_of on the superseded row (set by API).

alter table public.memories
  add column if not exists effective_at timestamptz not null default now();

comment on column public.memories.effective_at is
  'When this memory is considered active for retrieval; defaults to created_at semantics via default now().';

create index if not exists memories_effective_at_idx
  on public.memories (workspace_id, user_id, namespace, effective_at desc);

--------------------------------------------------------------------------------
-- Search RPCs: exclude chunks whose parent memory is not yet effective
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
      exp(-ln(2) * extract(epoch from (now() - coalesce(mc.last_accessed_at, mc.created_at))) / 86400.0 / 30) as decay_multiplier,
      greatest(coalesce(m.importance, 1.0::double precision), 0.01::double precision) as importance_mult,
      (
        1.0::double precision
        + least(
          ln(
            1.0::double precision + greatest(coalesce(m.retrieval_count, 0::bigint), 0::bigint)::double precision
          ) / 18.0::double precision,
          0.45::double precision
        )
      ) as retrieval_freq_mult
    from memory_chunks mc
    join memories m on m.id = mc.memory_id and m.workspace_id = mc.workspace_id
    where mc.workspace_id = p_workspace_id
      and mc.user_id = p_user_id
      and mc.namespace = p_namespace
      and m.duplicate_of is null
      and m.effective_at <= now()
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
    (
      base.raw_score
      * base.decay_multiplier
      * base.importance_mult
      * base.retrieval_freq_mult
    ) as score
  from base
  order by score desc
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
      exp(-ln(2) * extract(epoch from (now() - coalesce(mc.last_accessed_at, mc.created_at))) / 86400.0 / 30) as decay_multiplier,
      greatest(coalesce(m.importance, 1.0::double precision), 0.01::double precision) as importance_mult,
      (
        1.0::double precision
        + least(
          ln(
            1.0::double precision + greatest(coalesce(m.retrieval_count, 0::bigint), 0::bigint)::double precision
          ) / 18.0::double precision,
          0.45::double precision
        )
      ) as retrieval_freq_mult
    from memory_chunks mc
    join memories m on m.id = mc.memory_id and m.workspace_id = mc.workspace_id
    cross join tsquery tsq
    where mc.workspace_id = p_workspace_id
      and mc.user_id = p_user_id
      and mc.namespace = p_namespace
      and m.duplicate_of is null
      and m.effective_at <= now()
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
    (
      base.raw_score
      * base.decay_multiplier
      * base.importance_mult
      * base.retrieval_freq_mult
    ) as score
  from base
  order by score desc
  limit p_match_count;
$$;
