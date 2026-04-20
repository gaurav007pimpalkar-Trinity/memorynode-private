-- Advanced memory intelligence foundations (additive, backwards-compatible).
-- Adds schema for dedupe, scoring, conflict resolution history, and ingest control telemetry.

alter table public.memories
  add column if not exists canonical_hash text null,
  add column if not exists semantic_fingerprint text null,
  add column if not exists confidence double precision not null default 0.5,
  add column if not exists source_weight double precision not null default 1.0,
  add column if not exists priority_score double precision not null default 0.0,
  add column if not exists priority_tier text not null default 'warm',
  add column if not exists pinned_auto boolean not null default false,
  add column if not exists conflict_state text not null default 'none',
  add column if not exists last_conflict_at timestamptz null;

comment on column public.memories.canonical_hash is
  'Deterministic hash of normalized scoped memory text (exact dedupe key).';
comment on column public.memories.semantic_fingerprint is
  'Versioned semantic fingerprint for near-dedupe bucketing.';
comment on column public.memories.confidence is
  'Confidence score in [0,1] assigned at write time.';
comment on column public.memories.source_weight is
  'Relative trust weight for source metadata used in conflict resolution.';
comment on column public.memories.priority_score is
  'Write-time priority score in [0,1] used for retrieval and pinning decisions.';
comment on column public.memories.priority_tier is
  'Write-time tier derived from priority_score: cold|warm|hot|critical.';
comment on column public.memories.pinned_auto is
  'True when memory was auto-pinned by intelligence policy.';
comment on column public.memories.conflict_state is
  'Conflict state for memory: none|candidate|resolved|superseded.';

alter table public.memories
  drop constraint if exists memories_priority_tier_check;
alter table public.memories
  add constraint memories_priority_tier_check check (priority_tier in ('cold', 'warm', 'hot', 'critical'));

alter table public.memories
  drop constraint if exists memories_conflict_state_check;
alter table public.memories
  add constraint memories_conflict_state_check check (conflict_state in ('none', 'candidate', 'resolved', 'superseded'));

create index if not exists memories_scope_canonical_hash_idx
  on public.memories (workspace_id, user_id, namespace, canonical_hash)
  where duplicate_of is null and canonical_hash is not null;

create index if not exists memories_priority_active_idx
  on public.memories (workspace_id, user_id, namespace, priority_score desc, created_at desc)
  where duplicate_of is null;

create index if not exists memories_conflict_state_idx
  on public.memories (workspace_id, conflict_state, last_conflict_at desc);

create table if not exists public.memory_conflicts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  winner_memory_id uuid not null references public.memories(id) on delete cascade,
  loser_memory_id uuid not null references public.memories(id) on delete cascade,
  decision_reason text not null,
  features jsonb not null default '{}'::jsonb,
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, winner_memory_id, loser_memory_id)
);

create index if not exists memory_conflicts_workspace_resolved_idx
  on public.memory_conflicts (workspace_id, resolved_at desc);

create table if not exists public.memory_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  memory_id uuid not null references public.memories(id) on delete cascade,
  revision_no integer not null,
  text text not null,
  metadata jsonb not null default '{}'::jsonb,
  reason text null,
  source text null,
  created_at timestamptz not null default now(),
  unique (workspace_id, memory_id, revision_no)
);

create index if not exists memory_revisions_workspace_memory_idx
  on public.memory_revisions (workspace_id, memory_id, revision_no desc);

create table if not exists public.ingest_control_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id text not null,
  namespace text not null,
  canonical_hash text null,
  semantic_fingerprint text null,
  idempotency_key text null,
  event_type text not null,
  decision text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.ingest_control_events
  drop constraint if exists ingest_control_events_decision_check;
alter table public.ingest_control_events
  add constraint ingest_control_events_decision_check check (decision in ('allow', 'throttle', 'reject', 'flag'));

create index if not exists ingest_control_events_scope_created_idx
  on public.ingest_control_events (workspace_id, user_id, namespace, created_at desc);

create index if not exists ingest_control_events_idempotency_idx
  on public.ingest_control_events (workspace_id, idempotency_key, created_at desc)
  where idempotency_key is not null;

-- Refresh scoped RPCs to expose additive intelligence fields.
drop function if exists public.get_memory_scoped(uuid, uuid);
drop function if exists public.list_memories_scoped(
  uuid,
  integer,
  integer,
  text,
  text,
  text,
  jsonb,
  timestamptz,
  timestamptz
);

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
  retrieval_count bigint,
  confidence double precision,
  source_weight double precision,
  priority_score double precision,
  priority_tier text,
  pinned_auto boolean,
  conflict_state text,
  last_conflict_at timestamptz
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
    m.retrieval_count,
    m.confidence,
    m.source_weight,
    m.priority_score,
    m.priority_tier,
    m.pinned_auto,
    m.conflict_state,
    m.last_conflict_at
  from public.memories m
  where m.workspace_id = p_workspace_id
    and m.id = p_memory_id
  limit 1;
$$;

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
  confidence double precision,
  source_weight double precision,
  priority_score double precision,
  priority_tier text,
  pinned_auto boolean,
  conflict_state text,
  last_conflict_at timestamptz,
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
      m.retrieval_count,
      m.confidence,
      m.source_weight,
      m.priority_score,
      m.priority_tier,
      m.pinned_auto,
      m.conflict_state,
      m.last_conflict_at
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
    f.confidence,
    f.source_weight,
    f.priority_score,
    f.priority_tier,
    f.pinned_auto,
    f.conflict_state,
    f.last_conflict_at,
    count(*) over () as total_count
  from filtered f
  order by f.created_at desc, f.id desc
  limit greatest(1, p_page_size + 1)
  offset greatest(0, (greatest(1, p_page) - 1) * greatest(1, p_page_size));
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.get_memory_scoped(uuid, uuid) to service_role';
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
