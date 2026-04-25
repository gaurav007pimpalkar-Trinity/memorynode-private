-- 065_workspace_billing_cycle_token_usage_by_model.sql
-- Per-workspace, per-model, per-kind token usage in the current billing period.
-- Feeds the upgraded operator economics script with model-aware cost.
-- Models are read from usage_events.metadata when present; rows with NULL
-- model fall back to defaults in the script (backward compatible).

set search_path = public;

create or replace function list_workspace_billing_cycle_token_usage_by_model()
returns table (
  workspace_id uuid,
  workspace_name text,
  entitlement_id bigint,
  plan_code text,
  period_start timestamptz,
  period_end timestamptz,
  kind text,
  model text,
  tokens bigint,
  storage_bytes bigint,
  estimated_cost_inr_recorded numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with active_ent as (
    select
      e.id as ent_id,
      e.workspace_id as wid,
      w.name as wname,
      p.plan_code as p_code,
      e.period_start as p_start,
      e.period_end as p_end
    from entitlements e
    join plans p on p.id = e.plan_id
    join workspaces w on w.id = e.workspace_id
    where e.status in ('active', 'grace')
      and e.period_start <= now()
      and e.period_end > now()
  ),
  events as (
    select
      ae.wid,
      ae.wname,
      ae.ent_id,
      ae.p_code,
      ae.p_start,
      ae.p_end,
      coalesce(ue.metadata, '{}'::jsonb) as md,
      coalesce(ue.embed_tokens_delta, 0) as embed_tokens_delta,
      coalesce(ue.gen_input_tokens_delta, 0) as gen_input_tokens_delta,
      coalesce(ue.gen_output_tokens_delta, 0) as gen_output_tokens_delta,
      coalesce(ue.storage_bytes_delta, 0) as storage_bytes_delta,
      coalesce(ue.estimated_cost_inr, 0) as recorded_cost_inr
    from active_ent ae
    join usage_events ue
      on ue.workspace_id = ae.wid
     and coalesce(ue.billable, true) = true
     and ue.event_ts >= ae.p_start
     and ue.event_ts < ae.p_end
  )
  select
    wid as workspace_id,
    wname as workspace_name,
    ent_id as entitlement_id,
    p_code as plan_code,
    p_start as period_start,
    p_end as period_end,
    'embed'::text as kind,
    nullif(coalesce(md->>'embedding_model', md->>'embed_model', md->>'model'), '') as model,
    sum(embed_tokens_delta)::bigint as tokens,
    0::bigint as storage_bytes,
    sum(case when (gen_input_tokens_delta + gen_output_tokens_delta + storage_bytes_delta) = 0
             then recorded_cost_inr else 0 end)::numeric as estimated_cost_inr_recorded
  from events
  where embed_tokens_delta > 0
  group by 1, 2, 3, 4, 5, 6, 7, 8

  union all

  select
    wid, wname, ent_id, p_code, p_start, p_end,
    'gen_input'::text as kind,
    nullif(coalesce(md->>'gen_model', md->>'model'), '') as model,
    sum(gen_input_tokens_delta)::bigint as tokens,
    0::bigint as storage_bytes,
    0::numeric as estimated_cost_inr_recorded
  from events
  where gen_input_tokens_delta > 0
  group by 1, 2, 3, 4, 5, 6, 7, 8

  union all

  select
    wid, wname, ent_id, p_code, p_start, p_end,
    'gen_output'::text as kind,
    nullif(coalesce(md->>'gen_model', md->>'model'), '') as model,
    sum(gen_output_tokens_delta)::bigint as tokens,
    0::bigint as storage_bytes,
    0::numeric as estimated_cost_inr_recorded
  from events
  where gen_output_tokens_delta > 0
  group by 1, 2, 3, 4, 5, 6, 7, 8

  union all

  select
    wid, wname, ent_id, p_code, p_start, p_end,
    'storage'::text as kind,
    null::text as model,
    0::bigint as tokens,
    sum(storage_bytes_delta)::bigint as storage_bytes,
    0::numeric as estimated_cost_inr_recorded
  from events
  where storage_bytes_delta <> 0
  group by 1, 2, 3, 4, 5, 6
  ;
$$;

revoke all on function list_workspace_billing_cycle_token_usage_by_model() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function list_workspace_billing_cycle_token_usage_by_model() to service_role';
  end if;
end $$;
