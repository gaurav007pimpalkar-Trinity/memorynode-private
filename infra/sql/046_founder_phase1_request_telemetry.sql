-- Founder Phase 1 telemetry: persist lightweight request summaries so
-- founder KPIs can be queried in-product without relying on external logs.

create table if not exists api_request_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  request_id text,
  workspace_id uuid references workspaces(id) on delete set null,
  route text not null,
  route_group text not null,
  method text not null,
  status integer not null,
  latency_ms integer not null default 0
);

create index if not exists api_request_events_created_idx
  on api_request_events (created_at desc);

create index if not exists api_request_events_route_created_idx
  on api_request_events (route_group, created_at desc);

create index if not exists api_request_events_workspace_created_idx
  on api_request_events (workspace_id, created_at desc);

alter table if exists api_request_events enable row level security;

do $$
declare
  pol record;
begin
  for pol in
    select policyname from pg_policies where schemaname = 'public' and tablename = 'api_request_events'
  loop
    execute format('drop policy if exists %I on api_request_events', pol.policyname);
  end loop;

  create policy api_request_events_service_role_select on api_request_events
    for select using (auth.role() = 'service_role');

  create policy api_request_events_service_role_insert on api_request_events
    for insert with check (auth.role() = 'service_role');

  create policy api_request_events_service_role_update on api_request_events
    for update using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

  create policy api_request_events_service_role_delete on api_request_events
    for delete using (auth.role() = 'service_role');
end $$;
