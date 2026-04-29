-- Returns zero rows when core schema objects exist.
with required_tables(name) as (
  values
    ('workspaces'),
    ('workspace_members'),
    ('workspace_invites'),
    ('api_keys'),
    ('memories'),
    ('memory_chunks'),
    ('usage_daily'),
    ('api_audit_log'),
    ('product_events'),
    ('stripe_webhook_events'),
    ('payu_webhook_events'),
    ('payu_transactions'),
    ('workspace_entitlements'),
    ('plans'),
    ('entitlements'),
    ('usage_events'),
    ('usage_daily_v2'),
    ('invoice_lines'),
    ('usage_alert_events'),
    ('api_request_events'),
    ('memorynode_migrations'),
    ('dashboard_sessions'),
    ('eval_sets'),
    ('eval_items'),
    ('search_query_history'),
    ('admin_audit_log'),
    ('workspace_entitlement_audit')
),
missing_tables as (
  select name
  from required_tables
  where to_regclass('public.' || name) is null
),
required_functions(signature) as (
  values
    ('create_workspace(text)'),
    ('create_api_key(text,uuid)'),
    ('list_api_keys(uuid)'),
    ('revoke_api_key(uuid)'),
    ('bump_usage(uuid,date,integer,integer,integer)'),
    ('activation_counts(uuid,integer)')
),
missing_functions as (
  select signature
  from required_functions
  where to_regprocedure('public.' || signature) is null
),
required_columns(table_name, column_name) as (
  values
    ('workspaces', 'plan'),
    ('workspaces', 'plan_status'),
    ('workspaces', 'billing_provider'),
    ('workspaces', 'stripe_customer_id'),
    ('workspaces', 'stripe_last_event_created'),
    ('workspaces', 'stripe_last_event_id'),
    ('workspaces', 'payu_last_event_created'),
    ('workspaces', 'payu_last_event_id'),
    ('workspaces', 'payu_last_status'),
    ('workspaces', 'payu_txn_id'),
    ('workspaces', 'payu_payment_id'),
    ('workspaces', 'trial'),
    ('workspaces', 'trial_expires_at'),
    ('workspaces', 'internal'),
    ('workspaces', 'entitlement_source'),
    ('workspaces', 'internal_grant_enabled'),
    ('api_keys', 'key_hash'),
    ('memories', 'workspace_id'),
    ('memory_chunks', 'embedding'),
    ('usage_daily', 'reads'),
    ('product_events', 'event_name'),
    ('stripe_webhook_events', 'event_id'),
    ('stripe_webhook_events', 'status'),
    ('stripe_webhook_events', 'event_created'),
    ('stripe_webhook_events', 'processed_at'),
    ('stripe_webhook_events', 'defer_reason'),
    ('stripe_webhook_events', 'subscription_id'),
    ('payu_webhook_events', 'event_id'),
    ('payu_webhook_events', 'status'),
    ('payu_webhook_events', 'event_created'),
    ('payu_webhook_events', 'processed_at'),
    ('payu_webhook_events', 'defer_reason'),
    ('payu_webhook_events', 'txn_id'),
    ('payu_transactions', 'txn_id'),
    ('payu_transactions', 'workspace_id'),
    ('payu_transactions', 'amount'),
    ('payu_transactions', 'currency'),
    ('payu_transactions', 'status'),
    ('workspace_entitlements', 'workspace_id'),
    ('workspace_entitlements', 'source_txn_id'),
    ('workspace_entitlements', 'plan_code'),
    ('workspace_entitlements', 'status'),
    ('workspace_entitlements', 'expires_at'),
    ('workspace_entitlements', 'caps_json')
    ,
    ('plans', 'plan_code'),
    ('plans', 'price_inr'),
    ('plans', 'included_gen_tokens'),
    ('plans', 'included_storage_gb'),
    ('entitlements', 'workspace_id'),
    ('entitlements', 'plan_id'),
    ('entitlements', 'period_start'),
    ('entitlements', 'period_end'),
    ('usage_events', 'workspace_id'),
    ('usage_events', 'idempotency_key'),
    ('usage_events', 'embed_tokens_delta'),
    ('usage_events', 'gen_input_tokens_delta'),
    ('usage_events', 'gen_output_tokens_delta'),
    ('usage_daily_v2', 'workspace_id'),
    ('usage_daily_v2', 'embed_tokens'),
    ('usage_daily_v2', 'gen_input_tokens'),
    ('usage_daily_v2', 'gen_output_tokens'),
    ('invoice_lines', 'workspace_id'),
    ('invoice_lines', 'line_type'),
    ('invoice_lines', 'amount_inr'),
    ('usage_alert_events', 'workspace_id'),
    ('usage_alert_events', 'threshold_pct'),
    ('admin_audit_log', 'request_id'),
    ('admin_audit_log', 'admin_fingerprint'),
    ('admin_audit_log', 'route'),
    ('admin_audit_log', 'method'),
    ('admin_audit_log', 'result'),
    ('admin_audit_log', 'status_code')
    ,
    ('workspace_entitlement_audit', 'workspace_id'),
    ('workspace_entitlement_audit', 'changed_by'),
    ('workspace_entitlement_audit', 'previous_source'),
    ('workspace_entitlement_audit', 'new_source'),
    ('workspace_entitlement_audit', 'created_at')
),
missing_columns as (
  select rc.table_name, rc.column_name
  from required_columns rc
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = rc.table_name
      and c.column_name = rc.column_name
  )
)
select
  'missing_table' as kind,
  name as object_name,
  null::text as detail
from missing_tables
union all
select
  'missing_function' as kind,
  signature as object_name,
  null::text as detail
from missing_functions
union all
select
  'missing_column' as kind,
  table_name as object_name,
  column_name as detail
from missing_columns
order by 1, 2, 3;
