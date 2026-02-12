-- 021_payu_billing.sql - PayU billing provider migration

alter table if exists workspaces
  add column if not exists billing_provider text not null default 'payu',
  add column if not exists payu_txn_id text,
  add column if not exists payu_payment_id text,
  add column if not exists payu_last_status text,
  add column if not exists payu_last_plan text,
  add column if not exists payu_last_event_id text,
  add column if not exists payu_last_event_created bigint;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspaces_billing_provider_check'
  ) then
    alter table workspaces
      add constraint workspaces_billing_provider_check
      check (billing_provider in ('payu', 'legacy_stripe'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspaces_payu_last_status_check'
  ) then
    alter table workspaces
      add constraint workspaces_payu_last_status_check
      check (payu_last_status in ('success', 'pending', 'failure', 'canceled') or payu_last_status is null);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspaces_payu_last_plan_check'
  ) then
    alter table workspaces
      add constraint workspaces_payu_last_plan_check
      check (payu_last_plan in ('free', 'pro') or payu_last_plan is null);
  end if;
end$$;

create index if not exists workspaces_billing_provider_idx on workspaces (billing_provider);
create index if not exists workspaces_payu_last_event_created_idx on workspaces (payu_last_event_created);
create index if not exists workspaces_payu_txn_id_idx on workspaces (payu_txn_id);
create index if not exists workspaces_payu_payment_id_idx on workspaces (payu_payment_id);

create table if not exists payu_webhook_events (
  event_id text primary key,
  txn_id text not null,
  payment_id text,
  event_type text not null,
  event_created bigint not null,
  status text not null default 'processing',
  request_id text,
  workspace_id uuid,
  payu_status text,
  defer_reason text,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  received_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payu_webhook_events_status_check'
  ) then
    alter table payu_webhook_events
      add constraint payu_webhook_events_status_check
      check (status in ('processing', 'processed', 'failed', 'ignored_stale', 'deferred'));
  end if;
end$$;

create index if not exists payu_webhook_events_status_idx on payu_webhook_events (status);
create index if not exists payu_webhook_events_event_created_idx on payu_webhook_events (event_created);
create index if not exists payu_webhook_events_workspace_id_idx on payu_webhook_events (workspace_id);
create index if not exists payu_webhook_events_txn_id_idx on payu_webhook_events (txn_id);
create index if not exists payu_webhook_events_payment_id_idx on payu_webhook_events (payment_id);
