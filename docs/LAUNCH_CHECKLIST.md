# Launch Checklist (Pointer)

Canonical checklist is now:
- `docs/PROD_READY.md`

Canonical release commands are now:
- `docs/RELEASE_RUNBOOK.md`

Keep this file as a stable pointer only. Do not duplicate deploy commands here.

## PayU Go-Live Addendum

Required environment variables (names only):
- `PAYU_MERCHANT_KEY`
- `PAYU_MERCHANT_SALT`
- `PAYU_BASE_URL`
- `PAYU_VERIFY_URL`
- `PAYU_VERIFY_TIMEOUT_MS`
- `PAYU_CURRENCY`
- `PAYU_PRO_AMOUNT`
- `PAYU_PRODUCT_INFO`
- `PAYU_WEBHOOK_SECRET` (optional fallback signature mode)
- `PUBLIC_APP_URL`
- `PAYU_SUCCESS_PATH`
- `PAYU_CANCEL_PATH`
- `BILLING_WEBHOOKS_ENABLED`
- `BILLING_RECONCILE_ON_AMBIGUITY`

Required PayU callback URLs:
- Success URL: `${PUBLIC_APP_URL}${PAYU_SUCCESS_PATH}` (default `/settings/billing?status=success`)
- Failure URL: `${PUBLIC_APP_URL}${PAYU_CANCEL_PATH}` (default `/settings/billing?status=canceled`)
- Webhook/callback URL: `${API_BASE_URL}/v1/billing/webhook`

Verification and grant invariants:
- Webhook/callback processing must call the PayU Verify API (`PAYU_VERIFY_URL`) before entitlement grant.
- Entitlements must only be granted when verify response confirms matching `txnid`, amount, currency, and success status.
- Callback fields alone must never grant paid access.

Idempotency and replay handling:
- `payu_webhook_events.event_id` is the webhook idempotency key; duplicates are replay/no-op.
- `workspace_entitlements.source_txn_id` is unique per transaction to prevent duplicate grants.
- Transaction status transitions are monotonic and terminal for `success|failed|canceled`.

Migration manifest token (CI guard):
- `MIGRATIONS_TOTAL=24; MIGRATIONS_LATEST=022_payu_transactions_entitlements.sql`
