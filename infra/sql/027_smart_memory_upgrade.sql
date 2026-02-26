-- Phase 6: Smart memory upgrade — memory typing, search controls, hygiene support
-- All changes are additive; existing behavior is unchanged when new columns are NULL.

--------------------------------------------------------------------------------
-- 1. memories table: memory_type, source_memory_id, duplicate_of
--------------------------------------------------------------------------------

alter table memories
  add column if not exists memory_type text default null;

alter table memories
  add column if not exists source_memory_id uuid default null
    references memories(id) on delete set null;

alter table memories
  add column if not exists duplicate_of uuid default null
    references memories(id) on delete set null;

comment on column memories.memory_type is
  'Optional type tag: fact, preference, event, note. NULL means untyped (legacy).';
comment on column memories.source_memory_id is
  'If this memory was extracted from another, points to the source memory.';
comment on column memories.duplicate_of is
  'Set by hygiene job when this memory is a near-duplicate of another. Never auto-deleted.';

create index if not exists memories_memory_type_idx
  on memories (workspace_id, memory_type)
  where memory_type is not null;

create index if not exists memories_source_memory_idx
  on memories (source_memory_id)
  where source_memory_id is not null;

--------------------------------------------------------------------------------
-- 2. Updated vector search RPC — adds memory_type + filter_mode support
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
  order by mc.embedding <-> p_query_embedding
  limit p_match_count;
$$;

--------------------------------------------------------------------------------
-- 3. Updated text search RPC — adds memory_type + filter_mode support
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
  order by ts_rank_cd(mc.tsv, tsq.q) desc
  limit p_match_count;
$$;

--------------------------------------------------------------------------------
-- 4. Near-duplicate detection RPC for hygiene job
--    Returns pairs of memories whose chunks have cosine similarity above threshold.
--------------------------------------------------------------------------------

create or replace function find_near_duplicate_memories(
  p_workspace_id uuid,
  p_similarity_threshold float8 default 0.92,
  p_limit int default 200
) returns table (
  memory_id_a uuid,
  memory_id_b uuid,
  similarity float8,
  chunk_text_a text,
  chunk_text_b text
)
stable
language sql
as $$
  select distinct on (least(a.memory_id, b.memory_id), greatest(a.memory_id, b.memory_id))
    a.memory_id as memory_id_a,
    b.memory_id as memory_id_b,
    1 - (a.embedding <-> b.embedding) as similarity,
    a.chunk_text as chunk_text_a,
    b.chunk_text as chunk_text_b
  from memory_chunks a
  join memory_chunks b
    on a.workspace_id = b.workspace_id
    and a.user_id = b.user_id
    and a.namespace = b.namespace
    and a.memory_id < b.memory_id
  join memories ma on ma.id = a.memory_id and ma.workspace_id = a.workspace_id
  join memories mb on mb.id = b.memory_id and mb.workspace_id = b.workspace_id
  where a.workspace_id = p_workspace_id
    and ma.duplicate_of is null
    and mb.duplicate_of is null
    and 1 - (a.embedding <-> b.embedding) >= p_similarity_threshold
  order by
    least(a.memory_id, b.memory_id),
    greatest(a.memory_id, b.memory_id),
    1 - (a.embedding <-> b.embedding) desc
  limit p_limit;
$$;
