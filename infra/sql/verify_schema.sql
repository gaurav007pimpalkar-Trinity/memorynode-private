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
    ('memorynode_migrations')
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
    ('payu_webhook_events', 'txn_id')
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
