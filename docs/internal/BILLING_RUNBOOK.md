# Billing Webhook Runbook (PayU)

## Purpose
Production operations guide for PayU billing webhook/callback incidents:
- Hash/signature verification failures
- Replay and idempotency behavior
- Verify-before-grant (entitlements only after PayU verify API confirms)
- Deferred and failed event handling
- Safe reprocess and replay workflow

## Webhook Safety Model
- Endpoint: `POST /v1/billing/webhook`
- Hash verification: PayU hash is computed from payload fields + `PAYU_MERCHANT_SALT` and `PAYU_MERCHANT_KEY`; request hash must match. Raw body must be unmodified for verification.
- Verify-before-grant: Entitlements are granted only after the Worker calls the PayU verify API (`PAYU_VERIFY_URL`) and confirms matching `txnid`, amount, currency, and success status. Webhook payload alone does not grant access.
- Idempotency: `payu_webhook_events.event_id` (primary key) ensures duplicate callbacks are replayed safely.
- Processing status lifecycle in DB (`payu_webhook_events.status`):
  - `processing`
  - `processed`
  - `deferred` (workspace mapping missing or verify failed; safe to retry)
  - `ignored_stale` (older than current billing cursor)
  - `failed` (safe to retry/replay)
- Ordering cursor on `workspaces`:
  - `payu_last_event_created`
  - `payu_last_event_id`
  - `payu_last_plan`, `payu_last_status`
- Ambiguity reconciliation: Controlled by `BILLING_RECONCILE_ON_AMBIGUITY`. When enabled, Worker can use PayU verify API to resolve ordering conflicts.

## Inspect Webhook State (SQL)

Recent PayU webhook events:
```sql
select
  event_id,
  txn_id,
  payment_id,
  event_type,
  event_created,
  status,
  defer_reason,
  request_id,
  workspace_id,
  payu_status,
  left(coalesce(last_error, ''), 200) as last_error_preview,
  processed_at,
  received_at
from payu_webhook_events
order by coalesce(processed_at, received_at) desc
limit 100;
```

Deferred backlog:
```sql
select status, defer_reason, count(*) as total
from payu_webhook_events
where status = 'deferred'
group by status, defer_reason
order by total desc;
```

Single event by PayU event id / txn id:
```sql
select * from payu_webhook_events where event_id = '...';
select * from payu_webhook_events where txn_id = '...';
```

Workspace billing cursor:
```sql
select id, plan, plan_status,
  payu_txn_id, payu_payment_id, payu_last_status, payu_last_plan,
  payu_last_event_created, payu_last_event_id, updated_at
from workspaces where id = '...';
```

Entitlements (granted after verify):
```sql
select * from workspace_entitlements where workspace_id = '...' order by created_at desc;
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
- `billing_webhook_workspace_not_found`
- `billing_webhook_signature_invalid` (hash mismatch)

Recommended filters:
- `event_name="webhook_failed"`
- `event_name="webhook_deferred"`
- `event_name="webhook_reconciled"`
- `request_id="<x-request-id from client or PayU callback>"`

## Replay / Retry Procedure

1. Confirm the webhook row in `payu_webhook_events`:
   - If status is `processed` or `ignored_stale`, do **not** manually mutate billing state.
   - If status is `deferred`, fix mapping (e.g. workspace for the payment) and replay or call admin reprocess.
   - If status is `failed`, replay is safe (same event_id is retried).
2. Fix root cause (hash/secret mismatch, DB outage, mapping gap, PayU verify API unreachable, etc.).
3. Resend from PayU: Use PayU merchant dashboard to resend the callback to your webhook URL if supported; or use admin reprocess (below).
4. Admin batch reprocess (requires `x-admin-token`):
   - `POST /admin/webhooks/reprocess?status=deferred&limit=100`
   - Also supports `status=failed` for retry batches.
5. Verify:
   - `payu_webhook_events.status` becomes `processed` or `ignored_stale` (or remains `deferred` if mapping still missing).
   - `workspaces.payu_last_event_*` reflects newest event; `workspace_entitlements` updated when verify succeeds.
   - Logs show `webhook_verified` and `webhook_processed` (or `webhook_replayed` / `webhook_deferred` / `webhook_reconciled` as applicable).

## Common Failure Modes

1. **Invalid hash (signature verification failure)**
   - Symptoms: HTTP 400, `webhook_failed`, `billing_webhook_signature_invalid`.
   - Fix: Verify `PAYU_MERCHANT_KEY` and `PAYU_MERCHANT_SALT`, endpoint URL, and ensure raw body is unmodified (no re-parsing that changes field order).

2. **Workspace not found**
   - Symptoms: `billing_webhook_workspace_not_found`, `webhook_deferred`, HTTP 202 with deferred.
   - Fix: Ensure the payment/callback is associated with a workspace (e.g. via udf/merchant param); backfill mapping if needed, then replay or call `/admin/webhooks/reprocess?status=deferred`.

3. **Out-of-order events**
   - Symptoms: Older callback delivered after newer one.
   - Behavior: Without reconciliation, event can be marked `ignored_stale`; cursor not rolled back. With `BILLING_RECONCILE_ON_AMBIGUITY=1`, Worker can use PayU verify API to resolve.
   - Action: Enable `BILLING_RECONCILE_ON_AMBIGUITY=1` in the environment if needed.

4. **Transient DB or verify API failure**
   - Symptoms: Event row marked `failed`.
   - Behavior: Replay/resend is safe; same `event_id` can be retried.
   - Action: Restore DB or network health, resend or reprocess, verify status transition to `processed`.
