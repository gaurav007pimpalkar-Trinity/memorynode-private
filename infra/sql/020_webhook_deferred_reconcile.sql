-- 020_webhook_deferred_reconcile.sql - deferred webhook retries + reconcile metadata

alter table if exists stripe_webhook_events
  add column if not exists defer_reason text,
  add column if not exists subscription_id text;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'stripe_webhook_events_status_check'
  ) then
    alter table stripe_webhook_events drop constraint stripe_webhook_events_status_check;
  end if;

  alter table stripe_webhook_events
    add constraint stripe_webhook_events_status_check
    check (status in ('processing', 'processed', 'failed', 'ignored_stale', 'deferred'));
end$$;

create index if not exists stripe_webhook_events_subscription_id_idx on stripe_webhook_events (subscription_id);
