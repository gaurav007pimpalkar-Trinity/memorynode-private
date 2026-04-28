-- Persistent monthly LLM usage counter for progressive budget guard.

create table if not exists public.llm_usage_monthly (
  workspace_id uuid references public.workspaces(id) on delete cascade,
  month text not null,
  llm_calls bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, month),
  check (llm_calls >= 0)
);

create index if not exists llm_usage_monthly_updated_idx
  on public.llm_usage_monthly (updated_at desc);
