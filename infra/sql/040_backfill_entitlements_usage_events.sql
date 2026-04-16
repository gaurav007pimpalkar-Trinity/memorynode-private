-- 040_backfill_entitlements_usage_events.sql
-- Backfill entitlements + usage ledger from existing v2 tables.

set search_path = public;

-- Backfill v3 entitlements from existing workspace_entitlements rows.
insert into entitlements (
  workspace_id,
  plan_id,
  status,
  period_start,
  period_end,
  auto_renew,
  source_txn_id,
  billing_provider,
  hard_cap_enabled,
  soft_cap_enabled,
  budget_cap_inr,
  metadata,
  created_at,
  updated_at
)
select
  we.workspace_id,
  p.id,
  case
    when lower(coalesce(we.status, 'active')) in ('active', 'grace', 'expired', 'revoked', 'scheduled') then lower(coalesce(we.status, 'active'))
    when lower(coalesce(we.status, 'active')) = 'pending' then 'scheduled'
    else 'active'
  end as status,
  coalesce(we.starts_at, now()) as period_start,
  coalesce(
    we.expires_at,
    coalesce(we.starts_at, now()) + make_interval(days => greatest(1, coalesce(p.billing_cycle_days, 30)))
  ) as period_end,
  true as auto_renew,
  we.source_txn_id,
  'payu' as billing_provider,
  true as hard_cap_enabled,
  true as soft_cap_enabled,
  null::numeric(12,2) as budget_cap_inr,
  coalesce(we.metadata, '{}'::jsonb) || jsonb_build_object('backfill_source', 'workspace_entitlements'),
  coalesce(we.created_at, now()),
  coalesce(we.updated_at, now())
from workspace_entitlements we
join plans p
  on p.plan_code = case
    when lower(coalesce(we.plan_code, '')) in ('launch', 'build', 'deploy', 'scale', 'scale_plus') then lower(we.plan_code)
    when lower(coalesce(we.plan_code, '')) = 'pro' then 'build'
    when lower(coalesce(we.plan_code, '')) = 'team' then 'deploy'
    when lower(coalesce(we.plan_code, '')) = 'free' then 'launch'
    else 'build'
  end
where not exists (
  select 1
  from entitlements e
  where (we.source_txn_id is not null and e.source_txn_id = we.source_txn_id)
     or (
       e.workspace_id = we.workspace_id
       and e.plan_id = p.id
       and e.period_start = coalesce(we.starts_at, now())
       and e.period_end = coalesce(
         we.expires_at,
         coalesce(we.starts_at, now()) + make_interval(days => greatest(1, coalesce(p.billing_cycle_days, 30)))
       )
     )
);

-- Link payu_transactions.plan_id where missing.
update payu_transactions pt
set plan_id = p.id
from plans p
where pt.plan_id is null
  and p.plan_code = case
    when lower(coalesce(pt.plan_code, '')) in ('launch', 'build', 'deploy', 'scale', 'scale_plus') then lower(pt.plan_code)
    when lower(coalesce(pt.plan_code, '')) = 'pro' then 'build'
    when lower(coalesce(pt.plan_code, '')) = 'team' then 'deploy'
    when lower(coalesce(pt.plan_code, '')) = 'free' then 'launch'
    else 'build'
  end;

-- Backfill usage_events from usage_daily for historical observability (non-billable synthetic events).
insert into usage_events (
  workspace_id,
  entitlement_id,
  event_ts,
  request_id,
  idempotency_key,
  route,
  actor_type,
  actor_id,
  writes_delta,
  reads_delta,
  embeds_delta,
  extraction_calls_delta,
  embed_tokens_delta,
  gen_input_tokens_delta,
  gen_output_tokens_delta,
  storage_bytes_delta,
  estimated_cost_inr,
  billable,
  metadata
)
select
  u.workspace_id,
  null::bigint as entitlement_id,
  (u.day::text || ' 00:00:00+00')::timestamptz as event_ts,
  null::text as request_id,
  format('backfill:%s:%s', u.workspace_id, u.day) as idempotency_key,
  'backfill.usage_daily' as route,
  'system' as actor_type,
  null::text as actor_id,
  greatest(0, coalesce(u.writes, 0)) as writes_delta,
  greatest(0, coalesce(u.reads, 0)) as reads_delta,
  greatest(0, coalesce(u.embeds, 0)) as embeds_delta,
  greatest(0, coalesce(u.extraction_calls, 0)) as extraction_calls_delta,
  greatest(0, coalesce(u.embed_tokens_used, 0)) as embed_tokens_delta,
  0::bigint as gen_input_tokens_delta,
  0::bigint as gen_output_tokens_delta,
  0::bigint as storage_bytes_delta,
  0::numeric(12,6) as estimated_cost_inr,
  false as billable,
  jsonb_build_object('source', 'usage_daily_backfill')
from usage_daily u
where not exists (
  select 1 from usage_events ue
  where ue.workspace_id = u.workspace_id
    and ue.idempotency_key = format('backfill:%s:%s', u.workspace_id, u.day)
);

-- Sync daily v2 rollup with legacy usage_daily when missing.
insert into usage_daily_v2 (
  workspace_id,
  day,
  writes,
  reads,
  embeds,
  extraction_calls,
  embed_tokens,
  gen_input_tokens,
  gen_output_tokens,
  storage_bytes,
  estimated_cost_inr,
  last_event_at,
  updated_at
)
select
  u.workspace_id,
  u.day,
  coalesce(u.writes, 0),
  coalesce(u.reads, 0),
  coalesce(u.embeds, 0),
  coalesce(u.extraction_calls, 0),
  coalesce(u.embed_tokens_used, 0),
  0,
  0,
  0,
  0,
  now(),
  now()
from usage_daily u
on conflict (workspace_id, day) do nothing;

create or replace view workspace_entitlements_legacy_bridge as
select
  e.id,
  e.workspace_id,
  p.plan_code,
  e.status,
  e.period_start as starts_at,
  e.period_end as expires_at,
  jsonb_build_object(
    'writes', p.included_writes,
    'reads', p.included_reads,
    'embeds', floor(p.included_embed_tokens / 200.0)::int
  ) as caps_json,
  e.source_txn_id,
  e.metadata,
  e.created_at,
  e.updated_at
from entitlements e
join plans p on p.id = e.plan_id;
