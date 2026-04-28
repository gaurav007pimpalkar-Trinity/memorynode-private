-- Feedback signals for adaptive retrieval tuning (v1 deterministic loop).

create table if not exists public.memory_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  request_id text null,
  query text not null,
  query_pattern text not null,
  retrieved_memory_ids jsonb not null default '[]'::jsonb,
  response text not null default '',
  feedback text null,
  latency_ms integer not null default 0,
  created_at timestamptz not null default now(),
  check (feedback in ('positive', 'negative') or feedback is null)
);

create index if not exists memory_feedback_workspace_created_idx
  on public.memory_feedback (workspace_id, created_at desc);

create index if not exists memory_feedback_workspace_request_idx
  on public.memory_feedback (workspace_id, request_id)
  where request_id is not null;

create index if not exists memory_feedback_workspace_pattern_idx
  on public.memory_feedback (workspace_id, query_pattern, created_at desc);

create table if not exists public.memory_learning_adjustments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  query_pattern text not null,
  preferred_strategy text null,
  ideal_top_k integer null,
  min_score_delta double precision not null default 0,
  low_importance_penalty boolean not null default false,
  positive_count integer not null default 0,
  negative_count integer not null default 0,
  last_feedback_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, query_pattern),
  check (preferred_strategy in ('broad', 'focused', 'recent-first', 'important-first', 'hybrid') or preferred_strategy is null),
  check (ideal_top_k is null or (ideal_top_k >= 1 and ideal_top_k <= 50)),
  check (min_score_delta >= 0 and min_score_delta <= 0.5),
  check (positive_count >= 0 and negative_count >= 0)
);

create index if not exists memory_learning_adjustments_workspace_feedback_idx
  on public.memory_learning_adjustments (workspace_id, last_feedback_at desc nulls last);
