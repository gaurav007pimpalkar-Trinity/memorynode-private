# Billing Webhook Runbook

## Purpose
Production operations guide for Stripe webhook incidents:
- signature failures
- replay/idempotency behavior
- out-of-order event handling
- safe resend/retry workflow

## Webhook Safety Model
- Endpoint: `POST /v1/billing/webhook`
- Signature verification: Stripe SDK `constructEvent(raw, signature, secret, toleranceSec)` with default tolerance `300s` (override via `STRIPE_WEBHOOK_TOLERANCE_SEC`).
- Idempotency key: `stripe_webhook_events.event_id` (primary key).
- Processing status lifecycle in DB:
  - `processing`
  - `processed`
  - `deferred` (workspace/customer mapping missing, safe to retry)
  - `ignored_stale` (older than current billing cursor)
  - `failed` (safe to retry/replay)
- Deferred metadata fields:
  - `defer_reason` (for example `workspace_not_found`)
  - `subscription_id`
  - `customer_id`
- Ordering cursor on `workspaces`:
  - `stripe_last_event_created`
  - `stripe_last_event_id`
  - `stripe_last_event_type`
- Ambiguity reconciliation:
  - Controlled by `BILLING_RECONCILE_ON_AMBIGUITY`.
  - Default: enabled in production (`ENVIRONMENT=prod|production`), disabled in dev unless explicitly set.
  - Triggered on event-order ambiguity (same-second ties, stale ordering conflicts, unknown current subscription state).
  - Canonical fetch path: `stripe.subscriptions.retrieve(...)` (and `stripe.invoices.retrieve(...)` when invoice events need subscription resolution).

## Inspect Webhook State (SQL)

Recent webhook events:
```sql
select
  event_id,
  event_type,
  status,
  defer_reason,
  subscription_id,
  event_created,
  processed_at,
  request_id,
  workspace_id,
  customer_id,
  left(coalesce(last_error, ''), 200) as last_error_preview
from stripe_webhook_events
order by coalesce(processed_at, received_at) desc
limit 100;
```

Deferred backlog:
```sql
select
  status,
  defer_reason,
  count(*) as total
from stripe_webhook_events
where status = 'deferred'
group by status, defer_reason
order by total desc;
```

Single event by Stripe event id:
```sql
select *
from stripe_webhook_events
where event_id = 'evt_...';
```

Workspace billing cursor + state:
```sql
select
  id,
  plan,
  plan_status,
  stripe_customer_id,
  stripe_subscription_id,
  stripe_price_id,
  stripe_last_event_created,
  stripe_last_event_id,
  stripe_last_event_type,
  updated_at
from workspaces
where id = '...';
```

## Log Queries (Cloudflare Worker Logs)

Use these event names:
- `webhook_received`
- `webhook_verified`
- `webhook_processed`
- `webhook_replayed`
- `webhook_deferred`
- `webhook_reconciled`
- `webhook_failed`
- `billing_webhook_workspace_not_found` (mapping issue)
- `webhook_reprocess_started`
- `webhook_reprocess_processed`
- `webhook_reprocess_skipped`
- `webhook_reprocess_failed`

Recommended filters:
- `event_name="webhook_failed"`
- `event_name="webhook_replayed" AND stripe_event_id="evt_..."`
- `event_name="webhook_deferred"`
- `event_name="webhook_reconciled" AND stripe_event_id="evt_..."`
- `event_name=\"webhook_reprocess_failed\"`
- `request_id="<x-request-id from client/Stripe attempt>"`
- `stripe_event_id="evt_..."`

## Replay / Retry Procedure

1. Confirm the webhook row:
   - If status is `processed` or `ignored_stale`, do **not** manually mutate billing state.
   - If status is `deferred`, fix mapping and replay (same event id is re-attempted).
   - If status is `failed`, replay is safe (same event id is retried).
2. Fix root cause first (secret mismatch, DB outage, mapping gap, etc.).
3. Resend from Stripe:
   - Stripe Dashboard -> Developers -> Webhooks -> Events -> select event -> **Resend**.
   - Or Stripe CLI (example): `stripe events resend evt_... --webhook-endpoint=we_...`.
4. Optional admin batch reprocess (requires `x-admin-token`):
   - `POST /admin/webhooks/reprocess?status=deferred&limit=100`
   - Also supports `status=failed` for retry batches.
4. Verify:
   - `stripe_webhook_events.status` becomes `processed` or `ignored_stale` (or remains `deferred` if mapping still missing).
   - `workspaces.stripe_last_event_*` reflects newest event.
   - Logs show `webhook_verified` + `webhook_processed` (or `webhook_replayed` / `webhook_deferred` / `webhook_reconciled` as applicable).

## Common Failure Modes

1. Invalid signature (`invalid_webhook_signature`)
- Symptoms: HTTP 400, `webhook_failed`, `billing_webhook_signature_invalid`.
- Fix: verify `STRIPE_WEBHOOK_SECRET`, endpoint URL, and ensure raw body is unmodified.

2. Workspace not found
- Symptoms: `billing_webhook_workspace_not_found`, `webhook_deferred`, HTTP 202 with `webhook_deferred`.
- Fix: backfill `workspaces.stripe_customer_id` mapping, then resend event or call `/admin/webhooks/reprocess?status=deferred`.

3. Out-of-order events
- Symptoms: older event delivered after newer one.
- Behavior:
  - Without reconciliation flag: event is marked `ignored_stale`; billing cursor is not rolled back.
  - With reconciliation flag: worker fetches canonical Stripe state and applies it.
- Action: enable `BILLING_RECONCILE_ON_AMBIGUITY=1` if disabled in the current environment.

4. Transient DB failure
- Symptoms: event row marked `failed`.
- Behavior: replay/resend is safe; same `event_id` can be retried.
- Action: restore DB health, resend event, verify status transition to `processed`.
