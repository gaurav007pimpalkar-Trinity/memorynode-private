# Billing Runbook (PayU)

MemoryNode billing is PayU-only. The legacy Stripe webhook tables are retained for historical data; the Stripe portal endpoint (`POST /v1/billing/portal`) always returns `410 Gone`.

Source of truth:

- Handlers: [apps/api/src/handlers/billingCheckout.ts](../../apps/api/src/handlers/billingCheckout.ts), [billingWebhook.ts](../../apps/api/src/handlers/billingWebhook.ts), [billingStatus.ts](../../apps/api/src/handlers/billingStatus.ts), [billingPortal.ts](../../apps/api/src/handlers/billingPortal.ts).
- Plans: [packages/shared/src/plans.ts](../../packages/shared/src/plans.ts).
- Schema: `infra/sql/021_payu_billing.sql`, `022_payu_transactions_entitlements.sql`, `037_plans_entitlements_v3.sql`, `063_workspace_trial.sql`.

## 1. Secrets and env

Set via `wrangler secret put` on `memorynode-api`:

| Secret | Purpose |
| --- | --- |
| `PAYU_MERCHANT_KEY` | PayU merchant key |
| `PAYU_MERCHANT_SALT` | Used in request and webhook SHA-512 |
| `PAYU_WEBHOOK_SECRET` | Used for `x-payu-webhook-signature` HMAC-SHA256 fallback |
| `PAYU_LAUNCH_AMOUNT` / `PAYU_BUILD_AMOUNT` / `PAYU_DEPLOY_AMOUNT` / `PAYU_SCALE_AMOUNT` | Per-plan INR amounts (must match `plans.ts`) |
| `PAYU_PRO_AMOUNT` | Legacy fallback |
| `PAYU_PRODUCT_INFO`, `PAYU_SUCCESS_PATH`, `PAYU_CANCEL_PATH`, `PAYU_CURRENCY`, `PAYU_BASE_URL`, `PAYU_VERIFY_URL`, `PAYU_VERIFY_TIMEOUT_MS` | PayU hosted-checkout wiring |
| `BILLING_WEBHOOKS_ENABLED` | Toggle (default on). `off` causes webhook to 503. |
| `BILLING_RECONCILE_ON_AMBIGUITY` | `1` (default) runs PayU verify API on every ambiguous webhook |

## 2. Request flow: `POST /v1/billing/checkout`

1. Auth: API key or dashboard session.
2. Validate `plan`. Only `launch`, `build`, `deploy`, `scale` are accepted.
3. Insert `payu_transactions` row with a fresh `txnid` and status `initiated`.
4. Build SHA-512 hash over `PAYU_MERCHANT_KEY|txnid|amount|productinfo|firstname|email|||||||||||PAYU_MERCHANT_SALT` (`buildPayURequestHashInput`).
5. Return `{ url, method: "POST", fields }`. The dashboard auto-submits to PayU.

## 3. Webhook flow: `POST /v1/billing/webhook`

1. Accept raw `application/x-www-form-urlencoded` body.
2. Try **reverse SHA-512** over the PayU-signed fields; on failure, try **HMAC-SHA256** over the raw body keyed by `PAYU_WEBHOOK_SECRET` via `x-payu-webhook-signature`.
3. If both fail → emit `billing_webhook_signature_invalid` (alert **D2**) and return 400.
4. Lookup `payu_transactions` by `txnid`. If missing → emit `billing_webhook_workspace_not_found` (alert **D3**) and return 404.
5. Call PayU **verify API** (`verifyPayUTransactionViaApi`) with retry + timeout. On ambiguous result emit `webhook_deferred` (counts toward D4 backlog); otherwise continue.
6. Idempotency: insert into `payu_webhook_events` (unique on `payu_mihpayid` + event type). Duplicate → 200 no-op.
7. `upsertWorkspaceEntitlementFromTransaction` (Postgres RPC) writes/refreshes `workspace_entitlements` for the workspace.
8. Log `webhook_reconciled` (clears D4 backlog pairing).

Alerts: D1 `webhook_failed`/`billing_endpoint_error`, D2 signature invalid, D3 workspace missing, D4 `deferred − reconciled` backlog.

## 4. Portal (retired)

`POST /v1/billing/portal` always returns:

```json
{ "error": { "code": "GONE", "message": "Billing portal is retired; use PayU dashboard" } }
```

with status **410**. Do not re-enable a Stripe portal here. Customers manage subscriptions in the PayU dashboard.

## 5. Operational tasks

### 5.1 Reprocess deferred webhooks

```bash
curl -X POST https://api.memorynode.ai/admin/webhooks/reprocess \
  -H "x-admin-token: $MASTER_ADMIN_TOKEN"
```

Runs `reconcilePayUWebhook` over `webhook_deferred` events with no matching `webhook_reconciled`. Expect the D4 backlog metric to drain.

### 5.2 Admin billing health

```bash
curl https://api.memorynode.ai/v1/admin/billing/health -H "x-admin-token: $MASTER_ADMIN_TOKEN"
```

Returns a summary of PayU transaction state by status, webhook backlog, and last reconcile timestamp.

### 5.3 Usage reservation refunds

```bash
curl -X POST https://api.memorynode.ai/admin/usage/reconcile \
  -H "x-admin-token: $MASTER_ADMIN_TOKEN"
```

Runs `process_usage_reservation_refunds()` — releases abandoned reservations so their quota returns to the workspace.

### 5.4 Manual entitlement fix-up

Only permitted for confirmed operator incidents. Direct Supabase SQL:

```sql
update workspace_entitlements
set plan_id = 'build', current_period_end = now() + interval '30 days'
where workspace_id = '<uuid>';
```

Record the change in `api_audit_log` via an incident note, and confirm trial state (`workspace_trial`) is consistent.

## 6. Trial handling

`063_workspace_trial.sql` introduces `workspace_trial`. When a workspace's trial ends without a paid plan, billing-gated routes emit the `TRIAL_EXPIRED` error code; responses include `upgrade_url = ${PUBLIC_APP_URL}/billing` when `PUBLIC_APP_URL` is set.

## 7. Non-PayU providers (historical)

### Historical: Stripe tables

Tables from the pre-PayU era (`infra/sql/016_webhook_events.sql` and earlier billing migrations) still exist so historical events remain queryable. No code path in `apps/api/src/` writes to them. They are intentionally frozen and may be dropped in a future migration.

## 8. Related

- Incident response for billing webhooks: [INCIDENT_RUNBOOKS.md §3.3](./INCIDENT_RUNBOOKS.md).
- Alert descriptions: [ALERTS.md](./ALERTS.md) (D1–D4).
- Plan limits and overage rates: [packages/shared/src/plans.ts](../../packages/shared/src/plans.ts).
