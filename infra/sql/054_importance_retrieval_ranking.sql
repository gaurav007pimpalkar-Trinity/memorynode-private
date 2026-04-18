-- Importance multiplier + retrieval frequency boost in search ranking.
-- bump_memory_retrieval_counts increments when a memory appears in search results (app-called).

alter table public.memories
  add column if not exists importance double precision not null default 1.0;

alter table public.memories
  add column if not exists retrieval_count bigint not null default 0;

comment on column public.memories.importance is
  'Ranking multiplier (default 1). Higher boosts retrieved chunks; clamped to >= 0.01 in RPCs.';
comment on column public.memories.retrieval_count is
  'Increments when this memory appears in a search result page (best-effort).';

--------------------------------------------------------------------------------
-- Search RPCs: score *= importance_mult * retrieval_freq_mult
-- importance_mult = greatest(coalesce(importance, 1), 0.01)
-- retrieval_freq_mult = 1 + min(ln(1 + retrieval_count) / 18, 0.45)
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

--------------------------------------------------------------------------------
-- Increment retrieval_count for memories surfaced in search (batch).
--------------------------------------------------------------------------------

create or replace function public.bump_memory_retrieval_counts(
  p_workspace_id uuid,
  p_memory_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_memory_ids is null or coalesce(cardinality(p_memory_ids), 0) = 0 then
    return;
  end if;
  update public.memories m
  set retrieval_count = m.retrieval_count + 1
  where m.workspace_id = p_workspace_id
    and m.id = any(p_memory_ids);
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.bump_memory_retrieval_counts(uuid, uuid[]) to service_role';
  end if;
end$$;

--------------------------------------------------------------------------------
-- Scoped reads: expose new columns
--------------------------------------------------------------------------------

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
  source_memory_id uuid,
  importance double precision,
  retrieval_count bigint
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
    m.source_memory_id,
    m.importance,
    m.retrieval_count
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
  importance double precision,
  retrieval_count bigint,
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
      m.source_memory_id,
      m.importance,
      m.retrieval_count
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
    f.importance,
    f.retrieval_count,
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
