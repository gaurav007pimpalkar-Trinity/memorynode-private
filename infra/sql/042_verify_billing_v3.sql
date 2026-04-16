-- 042_verify_billing_v3.sql
-- Billing v3 verification checks.

with required_tables(name) as (
  values
    ('plans'),
    ('entitlements'),
    ('usage_events'),
    ('usage_daily_v2'),
    ('invoice_lines'),
    ('usage_alert_events')
),
missing_tables as (
  select name
  from required_tables
  where to_regclass('public.' || name) is null
),
required_functions(signature) as (
  values
    ('resolve_active_entitlement(uuid,timestamp with time zone)'),
    ('record_usage_event_if_within_cap(uuid,date,text,text,text,text,text,integer,integer,integer,bigint,integer,bigint,bigint,bigint,numeric,boolean,jsonb,bigint,bigint,bigint,bigint,bigint,bigint,bigint)'),
    ('compute_period_usage(uuid,timestamp with time zone,timestamp with time zone,bigint)'),
    ('build_invoice_lines_for_period(uuid,bigint,timestamp with time zone,timestamp with time zone,boolean)'),
    ('detect_usage_anomaly(uuid,date)')
),
missing_functions as (
  select signature
  from required_functions
  where to_regprocedure('public.' || signature) is null
),
pricing_expected(plan_code, price_inr, billing_cycle_days) as (
  values
    ('launch', 399.00::numeric, 7),
    ('build', 999.00::numeric, 30),
    ('deploy', 2999.00::numeric, 30),
    ('scale', 8999.00::numeric, 30)
),
pricing_mismatch as (
  select
    e.plan_code,
    e.price_inr as expected_price,
    p.price_inr as actual_price,
    e.billing_cycle_days as expected_cycle,
    p.billing_cycle_days as actual_cycle
  from pricing_expected e
  left join plans p on p.plan_code = e.plan_code
  where p.plan_code is null
     or p.price_inr <> e.price_inr
     or p.billing_cycle_days <> e.billing_cycle_days
)
select
  'missing_table' as kind,
  m.name as object_name,
  null::text as detail
from missing_tables m
union all
select
  'missing_function' as kind,
  f.signature as object_name,
  null::text as detail
from missing_functions f
union all
select
  'pricing_mismatch' as kind,
  pm.plan_code as object_name,
  format(
    'expected price=%s cycle=%s; actual price=%s cycle=%s',
    pm.expected_price,
    pm.expected_cycle,
    coalesce(pm.actual_price::text, 'null'),
    coalesce(pm.actual_cycle::text, 'null')
  ) as detail
from pricing_mismatch pm
order by 1, 2, 3;
