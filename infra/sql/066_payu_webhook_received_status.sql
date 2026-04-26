-- Allow explicit "received" lifecycle state before "processing" (webhook persistence).

alter table payu_webhook_events drop constraint if exists payu_webhook_events_status_check;

alter table payu_webhook_events
  add constraint payu_webhook_events_status_check
  check (status in ('received', 'processing', 'processed', 'failed', 'ignored_stale', 'deferred'));
