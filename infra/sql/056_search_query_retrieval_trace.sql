-- Persist a compact retrieval trace with search history (for replay / cockpit).

alter table public.search_query_history
  add column if not exists retrieval_trace jsonb;

comment on column public.search_query_history.retrieval_trace is
  'Structured trace: search_mode, candidate counts, fusion stats, retrieval_profile, etc.';
