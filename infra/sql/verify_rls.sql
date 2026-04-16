-- Pragmatic RLS verification.
-- We require:
-- 1) target tables exist
-- 2) RLS is enabled
-- 3) at least one policy exists
-- FORCE RLS is informational and not required.

with required_tables(relname) as (
  values
    ('api_audit_log'),
    ('api_keys'),
    ('memories'),
    ('memory_chunks'),
    ('payu_transactions'),
    ('plans'),
    ('entitlements'),
    ('usage_events'),
    ('usage_daily_v2'),
    ('invoice_lines'),
    ('usage_alert_events'),
    ('usage_daily'),
    ('workspace_entitlements'),
    ('workspaces'),
    ('eval_sets'),
    ('eval_items'),
    ('search_query_history')
),
table_state as (
  select
    r.relname,
    c.oid as table_oid,
    c.relrowsecurity,
    c.relforcerowsecurity,
    (
      select count(*)
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = r.relname
    ) as policy_count
  from required_tables r
  left join pg_namespace n
    on n.nspname = 'public'
  left join pg_class c
    on c.relnamespace = n.oid
   and c.relkind = 'r'
   and c.relname = r.relname
)
select
  relname,
  relrowsecurity,
  relforcerowsecurity,
  policy_count,
  case
    when table_oid is null then 'TABLE_MISSING'
    when relrowsecurity is not true then 'RLS_NOT_ENABLED'
    when policy_count < 1 then 'POLICY_MISSING'
    else null
  end as violation
from table_state
where table_oid is null
   or relrowsecurity is not true
   or policy_count < 1
order by relname;

-- Simulate tenant JWT (replace UUIDs as needed)
-- set local role authenticated;
-- set local "request.jwt.claims" = '{"workspace_id":"00000000-0000-0000-0000-000000000001"}';
-- select count(*) as visible_memories from memories;

-- Spoof attempt: claim set to a workspace without membership (expect 0)
-- set local "request.jwt.claims" = '{"workspace_id":"ffffffff-ffff-ffff-ffff-ffffffffffff"}';
-- select count(*) as cross_visible from memories;

-- Service role should see everything (RLS bypass)
-- reset role;
-- set local role service_role;
-- select count(*) as service_visible from memories;
