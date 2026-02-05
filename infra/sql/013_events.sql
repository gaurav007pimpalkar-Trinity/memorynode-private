-- 013_events.sql - product events for activation funnel
create table if not exists product_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  event_name text not null,
  request_id text,
  route text,
  method text,
  status integer,
  effective_plan text,
  plan_status text,
  props jsonb not null default '{}'::jsonb
);

create index if not exists product_events_workspace_created_idx on product_events (workspace_id, created_at desc);
create index if not exists product_events_event_created_idx on product_events (event_name, created_at desc);
