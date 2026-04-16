-- 041_rate_caps_budget_guards.sql
-- Progressive guardrails: daily burn caps, budget caps, alerts, anomaly detection.

set search_path = public;

create table if not exists usage_alert_events (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entitlement_id bigint references entitlements(id) on delete set null,
  day date not null,
  threshold_pct int not null,
  metric text not null,
  used_value numeric(20,6) not null,
  cap_value numeric(20,6) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint usage_alert_threshold_check check (threshold_pct in (70, 85, 100)),
  constraint usage_alert_metric_check check (metric in ('writes', 'reads', 'embed_tokens', 'gen_tokens', 'budget')),
  constraint usage_alert_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists usage_alert_events_unique_idx
  on usage_alert_events (workspace_id, entitlement_id, day, threshold_pct, metric);

alter table if exists usage_alert_events enable row level security;

drop policy if exists usage_alert_events_select on usage_alert_events;
drop policy if exists usage_alert_events_modify on usage_alert_events;

create policy usage_alert_events_select on usage_alert_events
  for select using (
    auth.role() = 'service_role'
    or exists (
      select 1 from workspace_members m
      where m.workspace_id = usage_alert_events.workspace_id and m.user_id = auth.uid()
    )
  );

create policy usage_alert_events_modify on usage_alert_events
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function detect_usage_anomaly(
  p_workspace_id uuid,
  p_day date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with u as (
    select *
    from usage_daily_v2
    where workspace_id = p_workspace_id
      and day = p_day
  )
  select coalesce(jsonb_agg(flag), '[]'::jsonb)
  from (
    select to_jsonb('high_reads_no_writes'::text) as flag
    from u
    where reads >= 1000 and writes = 0
    union all
    select to_jsonb('extreme_read_write_ratio'::text) as flag
    from u
    where writes > 0 and (reads::numeric / writes::numeric) >= 80
    union all
    select to_jsonb('embed_spike'::text) as flag
    from u
    where embed_tokens >= 1000000
    union all
    select to_jsonb('gen_spike'::text) as flag
    from u
    where (gen_input_tokens + gen_output_tokens) >= 3000000
  ) f;
$$;

create or replace function record_usage_event_if_within_cap(
  p_workspace_id uuid,
  p_day date,
  p_idempotency_key text,
  p_request_id text,
  p_route text,
  p_actor_type text,
  p_actor_id text,
  p_writes int,
  p_reads int,
  p_embeds int,
  p_embed_tokens bigint,
  p_extraction_calls int,
  p_gen_input_tokens bigint,
  p_gen_output_tokens bigint,
  p_storage_bytes bigint,
  p_estimated_cost_inr numeric(12,6),
  p_billable boolean,
  p_metadata jsonb,
  p_writes_cap bigint,
  p_reads_cap bigint,
  p_embeds_cap bigint,
  p_embed_tokens_cap bigint,
  p_extraction_calls_cap bigint,
  p_gen_tokens_cap bigint,
  p_storage_bytes_cap bigint
)
returns table (
  workspace_id uuid,
  day date,
  writes bigint,
  reads bigint,
  embeds bigint,
  extraction_calls bigint,
  embed_tokens_used bigint,
  gen_input_tokens_used bigint,
  gen_output_tokens_used bigint,
  storage_bytes_used bigint,
  exceeded boolean,
  limit_name text,
  usage_event_id uuid,
  entitlement_id bigint,
  idempotent_replay boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date;
  v_entitlement_id bigint;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_budget_cap numeric(12,2);
  v_daily_pct_cap numeric(5,2);
  v_hard_cap_enabled boolean := true;
  v_soft_cap_enabled boolean := true;
  v_writes bigint := 0;
  v_reads bigint := 0;
  v_embeds bigint := 0;
  v_extraction_calls bigint := 0;
  v_embed_tokens bigint := 0;
  v_gen_input_tokens bigint := 0;
  v_gen_output_tokens bigint := 0;
  v_storage_bytes bigint := 0;
  v_existing_event uuid;
  v_inserted_event uuid;
  v_plan plans%rowtype;
  v_daily_writes_cap bigint;
  v_daily_reads_cap bigint;
  v_daily_embed_cap bigint;
  v_daily_gen_cap bigint;
  v_budget_used numeric(12,6) := 0;
  v_gen_after bigint;
begin
  if p_workspace_id is null then
    raise exception 'workspace_id is required';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency_key is required';
  end if;

  v_day := coalesce(p_day, (now() at time zone 'utc')::date);
  p_writes := greatest(0, coalesce(p_writes, 0));
  p_reads := greatest(0, coalesce(p_reads, 0));
  p_embeds := greatest(0, coalesce(p_embeds, 0));
  p_extraction_calls := greatest(0, coalesce(p_extraction_calls, 0));
  p_embed_tokens := greatest(0, coalesce(p_embed_tokens, 0));
  p_gen_input_tokens := greatest(0, coalesce(p_gen_input_tokens, 0));
  p_gen_output_tokens := greatest(0, coalesce(p_gen_output_tokens, 0));
  p_storage_bytes := coalesce(p_storage_bytes, 0);
  p_estimated_cost_inr := coalesce(p_estimated_cost_inr, 0);
  p_billable := coalesce(p_billable, true);
  p_route := coalesce(nullif(trim(p_route), ''), 'unknown');
  p_actor_type := coalesce(nullif(trim(p_actor_type), ''), 'system');
  p_metadata := coalesce(p_metadata, '{}'::jsonb);

  select
    e.entitlement_id,
    e.plan_id,
    e.period_start,
    e.period_end,
    e.budget_cap_inr,
    e.hard_cap_enabled,
    e.soft_cap_enabled,
    e.daily_usage_pct_cap
  into
    v_entitlement_id,
    v_plan.id,
    v_period_start,
    v_period_end,
    v_budget_cap,
    v_hard_cap_enabled,
    v_soft_cap_enabled,
    v_daily_pct_cap
  from resolve_active_entitlement(p_workspace_id, now()) e
  limit 1;

  if v_plan.id is not null then
    select * into v_plan from plans where id = v_plan.id;
  else
    select * into v_plan from plans where plan_code = 'launch' limit 1;
    v_period_start := (v_day::text || ' 00:00:00+00')::timestamptz;
    v_period_end := v_period_start + interval '1 day';
    v_daily_pct_cap := coalesce(v_plan.daily_usage_pct_cap, 15);
  end if;

  v_daily_writes_cap := greatest(1, floor(v_plan.included_writes * (coalesce(v_daily_pct_cap, 15) / 100.0))::bigint);
  v_daily_reads_cap := greatest(1, floor(v_plan.included_reads * (coalesce(v_daily_pct_cap, 15) / 100.0))::bigint);
  v_daily_embed_cap := greatest(1, floor(v_plan.included_embed_tokens * (coalesce(v_daily_pct_cap, 15) / 100.0))::bigint);
  v_daily_gen_cap := greatest(1, floor(v_plan.included_gen_tokens * (coalesce(v_daily_pct_cap, 15) / 100.0))::bigint);

  p_writes_cap := least(coalesce(nullif(p_writes_cap, 0), v_plan.included_writes), v_daily_writes_cap);
  p_reads_cap := least(coalesce(nullif(p_reads_cap, 0), v_plan.included_reads), v_daily_reads_cap);
  p_embed_tokens_cap := least(coalesce(nullif(p_embed_tokens_cap, 0), v_plan.included_embed_tokens), v_daily_embed_cap);
  p_gen_tokens_cap := least(coalesce(nullif(p_gen_tokens_cap, 0), v_plan.included_gen_tokens), v_daily_gen_cap);
  if coalesce(p_storage_bytes_cap, 0) = 0 then
    p_storage_bytes_cap := floor(v_plan.included_storage_gb * 1000000000.0)::bigint;
  end if;
  if coalesce(p_extraction_calls_cap, 0) = 0 then
    p_extraction_calls_cap := coalesce(v_plan.included_extraction_calls, 0);
  end if;
  if coalesce(p_embeds_cap, 0) = 0 then
    p_embeds_cap := greatest(1, floor(p_embed_tokens_cap / 200.0)::bigint);
  end if;

  select id
    into v_existing_event
  from usage_events ue
  where ue.workspace_id = p_workspace_id
    and ue.idempotency_key = p_idempotency_key
  limit 1;

  if v_existing_event is not null then
    select
      coalesce(u.writes, 0),
      coalesce(u.reads, 0),
      coalesce(u.embeds, 0),
      coalesce(u.extraction_calls, 0),
      coalesce(u.embed_tokens, 0),
      coalesce(u.gen_input_tokens, 0),
      coalesce(u.gen_output_tokens, 0),
      coalesce(u.storage_bytes, 0)
    into
      v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes
    from usage_daily_v2 u
    where u.workspace_id = p_workspace_id and u.day = v_day
    for update;

    return query
    select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, false, null::text, v_existing_event, v_entitlement_id, true;
    return;
  end if;

  select
    coalesce(u.writes, 0),
    coalesce(u.reads, 0),
    coalesce(u.embeds, 0),
    coalesce(u.extraction_calls, 0),
    coalesce(u.embed_tokens, 0),
    coalesce(u.gen_input_tokens, 0),
    coalesce(u.gen_output_tokens, 0),
    coalesce(u.storage_bytes, 0)
  into
    v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes
  from usage_daily_v2 u
  where u.workspace_id = p_workspace_id and u.day = v_day
  for update;

  if v_hard_cap_enabled and ((v_writes + p_writes) > p_writes_cap) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'writes', null::uuid, v_entitlement_id, false;
    return;
  end if;
  if v_hard_cap_enabled and ((v_reads + p_reads) > p_reads_cap) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'reads', null::uuid, v_entitlement_id, false;
    return;
  end if;
  if v_hard_cap_enabled and ((v_embeds + p_embeds) > p_embeds_cap) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'embeds', null::uuid, v_entitlement_id, false;
    return;
  end if;
  if v_hard_cap_enabled and ((v_embed_tokens + p_embed_tokens) > p_embed_tokens_cap) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'embed_tokens', null::uuid, v_entitlement_id, false;
    return;
  end if;
  if v_hard_cap_enabled and ((v_extraction_calls + p_extraction_calls) > p_extraction_calls_cap) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'extraction_calls', null::uuid, v_entitlement_id, false;
    return;
  end if;

  v_gen_after := v_gen_input_tokens + v_gen_output_tokens + p_gen_input_tokens + p_gen_output_tokens;
  if v_hard_cap_enabled and (v_gen_after > p_gen_tokens_cap) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'gen_tokens', null::uuid, v_entitlement_id, false;
    return;
  end if;

  if v_hard_cap_enabled and (greatest(0, v_storage_bytes + p_storage_bytes) > p_storage_bytes_cap) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'storage_bytes', null::uuid, v_entitlement_id, false;
    return;
  end if;

  if v_hard_cap_enabled and v_budget_cap is not null then
    select coalesce(sum(ue.estimated_cost_inr), 0)
      into v_budget_used
    from usage_events ue
    where ue.workspace_id = p_workspace_id
      and ue.event_ts >= v_period_start
      and ue.event_ts < v_period_end
      and (v_entitlement_id is null or ue.entitlement_id = v_entitlement_id);

    if (v_budget_used + p_estimated_cost_inr) > v_budget_cap then
      return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'budget', null::uuid, v_entitlement_id, false;
      return;
    end if;
  end if;

  insert into usage_events (
    workspace_id, entitlement_id, event_ts, request_id, idempotency_key, route, actor_type, actor_id,
    writes_delta, reads_delta, embeds_delta, extraction_calls_delta, embed_tokens_delta,
    gen_input_tokens_delta, gen_output_tokens_delta, storage_bytes_delta,
    estimated_cost_inr, billable, abuse_flags, metadata
  )
  values (
    p_workspace_id, v_entitlement_id, (v_day::text || ' 00:00:00+00')::timestamptz, p_request_id, p_idempotency_key, p_route, p_actor_type, p_actor_id,
    p_writes, p_reads, p_embeds, p_extraction_calls, p_embed_tokens,
    p_gen_input_tokens, p_gen_output_tokens, p_storage_bytes,
    p_estimated_cost_inr, p_billable, detect_usage_anomaly(p_workspace_id, v_day), p_metadata
  )
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into v_inserted_event;

  if v_inserted_event is null then
    select id into v_existing_event
    from usage_events ue
    where ue.workspace_id = p_workspace_id
      and ue.idempotency_key = p_idempotency_key
    limit 1;

    return query
    select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, false, null::text, v_existing_event, v_entitlement_id, true;
    return;
  end if;

  insert into usage_daily_v2 (
    workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens, gen_input_tokens, gen_output_tokens, storage_bytes, estimated_cost_inr, last_event_at, updated_at
  )
  values (
    p_workspace_id, v_day, p_writes, p_reads, p_embeds, p_extraction_calls, p_embed_tokens, p_gen_input_tokens, p_gen_output_tokens, p_storage_bytes, p_estimated_cost_inr, now(), now()
  )
  on conflict (workspace_id, day)
  do update set
    writes = usage_daily_v2.writes + excluded.writes,
    reads = usage_daily_v2.reads + excluded.reads,
    embeds = usage_daily_v2.embeds + excluded.embeds,
    extraction_calls = usage_daily_v2.extraction_calls + excluded.extraction_calls,
    embed_tokens = usage_daily_v2.embed_tokens + excluded.embed_tokens,
    gen_input_tokens = usage_daily_v2.gen_input_tokens + excluded.gen_input_tokens,
    gen_output_tokens = usage_daily_v2.gen_output_tokens + excluded.gen_output_tokens,
    storage_bytes = usage_daily_v2.storage_bytes + excluded.storage_bytes,
    estimated_cost_inr = usage_daily_v2.estimated_cost_inr + excluded.estimated_cost_inr,
    last_event_at = now(),
    updated_at = now();

  insert into usage_daily (workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens_used)
  values (p_workspace_id, v_day, p_writes, p_reads, p_embeds, p_extraction_calls, p_embed_tokens)
  on conflict (workspace_id, day)
  do update set
    writes = usage_daily.writes + excluded.writes,
    reads = usage_daily.reads + excluded.reads,
    embeds = usage_daily.embeds + excluded.embeds,
    extraction_calls = usage_daily.extraction_calls + excluded.extraction_calls,
    embed_tokens_used = usage_daily.embed_tokens_used + excluded.embed_tokens_used;

  select
    coalesce(u.writes, 0),
    coalesce(u.reads, 0),
    coalesce(u.embeds, 0),
    coalesce(u.extraction_calls, 0),
    coalesce(u.embed_tokens, 0),
    coalesce(u.gen_input_tokens, 0),
    coalesce(u.gen_output_tokens, 0),
    coalesce(u.storage_bytes, 0)
  into
    v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes
  from usage_daily_v2 u
  where u.workspace_id = p_workspace_id and u.day = v_day;

  if v_soft_cap_enabled then
    insert into usage_alert_events (workspace_id, entitlement_id, day, threshold_pct, metric, used_value, cap_value, metadata)
    select p_workspace_id, v_entitlement_id, v_day, t.threshold_pct, t.metric, t.used_value, t.cap_value, t.metadata
    from (
      values
        (70, 'writes', v_writes::numeric, p_writes_cap::numeric, jsonb_build_object('route', p_route)),
        (85, 'writes', v_writes::numeric, p_writes_cap::numeric, jsonb_build_object('route', p_route)),
        (100, 'writes', v_writes::numeric, p_writes_cap::numeric, jsonb_build_object('route', p_route)),
        (70, 'reads', v_reads::numeric, p_reads_cap::numeric, jsonb_build_object('route', p_route)),
        (85, 'reads', v_reads::numeric, p_reads_cap::numeric, jsonb_build_object('route', p_route)),
        (100, 'reads', v_reads::numeric, p_reads_cap::numeric, jsonb_build_object('route', p_route)),
        (70, 'embed_tokens', v_embed_tokens::numeric, p_embed_tokens_cap::numeric, jsonb_build_object('route', p_route)),
        (85, 'embed_tokens', v_embed_tokens::numeric, p_embed_tokens_cap::numeric, jsonb_build_object('route', p_route)),
        (100, 'embed_tokens', v_embed_tokens::numeric, p_embed_tokens_cap::numeric, jsonb_build_object('route', p_route)),
        (70, 'gen_tokens', (v_gen_input_tokens + v_gen_output_tokens)::numeric, p_gen_tokens_cap::numeric, jsonb_build_object('route', p_route)),
        (85, 'gen_tokens', (v_gen_input_tokens + v_gen_output_tokens)::numeric, p_gen_tokens_cap::numeric, jsonb_build_object('route', p_route)),
        (100, 'gen_tokens', (v_gen_input_tokens + v_gen_output_tokens)::numeric, p_gen_tokens_cap::numeric, jsonb_build_object('route', p_route))
    ) as t(threshold_pct, metric, used_value, cap_value, metadata)
    where t.cap_value > 0
      and ((t.used_value / t.cap_value) * 100.0) >= t.threshold_pct
    on conflict (workspace_id, entitlement_id, day, threshold_pct, metric) do nothing;

    if v_budget_cap is not null and v_budget_cap > 0 then
      select coalesce(sum(ue.estimated_cost_inr), 0)
        into v_budget_used
      from usage_events ue
      where ue.workspace_id = p_workspace_id
        and ue.event_ts >= v_period_start
        and ue.event_ts < v_period_end
        and (v_entitlement_id is null or ue.entitlement_id = v_entitlement_id);

      insert into usage_alert_events (workspace_id, entitlement_id, day, threshold_pct, metric, used_value, cap_value, metadata)
      select p_workspace_id, v_entitlement_id, v_day, b.threshold_pct, 'budget', v_budget_used, v_budget_cap, jsonb_build_object('route', p_route)
      from (values (70), (85), (100)) as b(threshold_pct)
      where ((v_budget_used / v_budget_cap) * 100.0) >= b.threshold_pct
      on conflict (workspace_id, entitlement_id, day, threshold_pct, metric) do nothing;
    end if;
  end if;

  return query
  select
    p_workspace_id,
    v_day,
    v_writes,
    v_reads,
    v_embeds,
    v_extraction_calls,
    v_embed_tokens,
    v_gen_input_tokens,
    v_gen_output_tokens,
    v_storage_bytes,
    false::boolean,
    null::text,
    v_inserted_event,
    v_entitlement_id,
    false::boolean;
end;
$$;

revoke all on table usage_alert_events from public;
revoke all on function detect_usage_anomaly(uuid, date) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on table usage_alert_events to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table usage_alert_events to service_role';
    execute 'grant usage, select on sequence usage_alert_events_id_seq to service_role';
    execute 'grant execute on function detect_usage_anomaly(uuid, date) to service_role';
    execute 'grant execute on function record_usage_event_if_within_cap(
      uuid, date, text, text, text, text, text, int, int, int, bigint, int, bigint, bigint, bigint, numeric, boolean, jsonb, bigint, bigint, bigint, bigint, bigint, bigint, bigint
    ) to service_role';
  end if;
end $$;
