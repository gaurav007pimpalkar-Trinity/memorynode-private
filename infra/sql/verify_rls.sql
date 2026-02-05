-- Quick RLS verification queries

-- Check RLS flag
select relname, relrowsecurity
from pg_class
where relname in ('workspaces','api_keys','memories','memory_chunks','usage_daily','api_audit_log')
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
