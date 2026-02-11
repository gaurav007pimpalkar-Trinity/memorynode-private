-- 019_webhook_hardening.sql - webhook replay safety + ordering cursor

alter table if exists stripe_webhook_events
  add column if not exists event_type text,
  add column if not exists event_created bigint,
  add column if not exists status text not null default 'processed',
  add column if not exists processed_at timestamptz,
  add column if not exists request_id text,
  add column if not exists workspace_id uuid,
  add column if not exists customer_id text,
  add column if not exists last_error text;

update stripe_webhook_events
set
  status = coalesce(status, 'processed'),
  processed_at = coalesce(processed_at, received_at);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stripe_webhook_events_status_check'
  ) then
    alter table stripe_webhook_events
      add constraint stripe_webhook_events_status_check
      check (status in ('processing', 'processed', 'failed', 'ignored_stale'));
  end if;
end$$;

create index if not exists stripe_webhook_events_status_idx on stripe_webhook_events (status);
create index if not exists stripe_webhook_events_event_created_idx on stripe_webhook_events (event_created);
create index if not exists stripe_webhook_events_workspace_id_idx on stripe_webhook_events (workspace_id);
create index if not exists stripe_webhook_events_customer_id_idx on stripe_webhook_events (customer_id);

alter table if exists workspaces
  add column if not exists stripe_last_event_id text,
  add column if not exists stripe_last_event_type text,
  add column if not exists stripe_last_event_created bigint;

create index if not exists workspaces_stripe_last_event_created_idx on workspaces (stripe_last_event_created);
