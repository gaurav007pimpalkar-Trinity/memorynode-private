-- 016_webhook_events.sql - idempotency for Stripe webhooks
create table if not exists stripe_webhook_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

-- simple TTL via cleanup job (optional) can be added separately; keep bounded size with constraint by application.
