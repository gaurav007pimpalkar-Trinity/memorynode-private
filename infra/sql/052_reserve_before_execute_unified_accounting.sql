-- 052_reserve_before_execute_unified_accounting.sql
-- Enforce strict reserve-before-execute flow and commit usage from reservations.

set search_path = public;

alter table if exists usage_reservations
  add column if not exists internal_credits_total bigint not null default 0,
  add column if not exists usage_event_id uuid references usage_events(id) on delete set null,
  add column if not exists idempotency_key text;

create unique index if not exists usage_reservations_workspace_request_unique
  on usage_reservations (workspace_id, request_id)
  where request_id is not null;

create unique index if not exists usage_reservations_workspace_idempotency_unique
  on usage_reservations (workspace_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.reserve_usage_if_within_cap(
  p_workspace_id uuid,
  p_day date,
  p_request_id text,
  p_route text,
  p_writes_delta int,
  p_reads_delta int,
  p_embeds_delta int,
  p_embed_tokens_delta int,
  p_extraction_calls_delta int,
  p_estimated_cost_inr numeric(12,6),
  p_internal_credits_total bigint,
  p_cost_per_minute_cap_inr numeric(12,6),
  p_writes_cap bigint,
  p_reads_cap bigint,
  p_embeds_cap bigint,
  p_embed_tokens_cap bigint,
  p_extraction_calls_cap bigint,
  p_gen_tokens_cap bigint,
  p_storage_bytes_cap bigint
)
returns table (
  reservation_id uuid,
  exceeded boolean,
  limit_name text,
  used_value numeric(20,6),
  cap_value numeric(20,6),
  idempotent_replay boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date;
  v_existing usage_reservations%rowtype;
  v_entitlement_id bigint;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_budget_cap numeric(12,2);
  v_daily_pct_cap numeric(5,2);
  v_hard_cap_enabled boolean := true;
  v_plan plans%rowtype;
  v_writes bigint := 0;
  v_reads bigint := 0;
  v_embeds bigint := 0;
  v_extraction_calls bigint := 0;
  v_embed_tokens bigint := 0;
  v_gen_input_tokens bigint := 0;
  v_gen_output_tokens bigint := 0;
  v_storage_bytes bigint := 0;
  v_reserved_writes bigint := 0;
  v_reserved_reads bigint := 0;
  v_reserved_embeds bigint := 0;
  v_reserved_extraction_calls bigint := 0;
  v_reserved_embed_tokens bigint := 0;
  v_reserved_gen_tokens bigint := 0;
  v_reserved_storage_bytes bigint := 0;
  v_reserved_budget_inr numeric(20,6) := 0;
  v_budget_used numeric(20,6) := 0;
  v_daily_writes_cap bigint;
  v_daily_reads_cap bigint;
  v_daily_embed_cap bigint;
  v_daily_gen_cap bigint;
begin
  if p_workspace_id is null then
    raise exception 'workspace_id is required';
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 then
    raise exception 'request_id is required';
  end if;

  v_day := coalesce(p_day, (now() at time zone 'utc')::date);
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 1));
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || v_day::text, 0));

  p_route := coalesce(nullif(trim(p_route), ''), 'unknown');
  p_writes_delta := greatest(0, coalesce(p_writes_delta, 0));
  p_reads_delta := greatest(0, coalesce(p_reads_delta, 0));
  p_embeds_delta := greatest(0, coalesce(p_embeds_delta, 0));
  p_embed_tokens_delta := greatest(0, coalesce(p_embed_tokens_delta, 0));
  p_extraction_calls_delta := greatest(0, coalesce(p_extraction_calls_delta, 0));
  p_estimated_cost_inr := greatest(0, coalesce(p_estimated_cost_inr, 0));
  p_internal_credits_total := greatest(0, coalesce(p_internal_credits_total, 0));

  select *
    into v_existing
  from usage_reservations
  where workspace_id = p_workspace_id
    and request_id = p_request_id
    and status in ('reserved', 'committed', 'refund_pending')
  order by created_at desc
  limit 1
  for update;

  if found then
    if coalesce(v_existing.route, '') <> p_route
       or coalesce(v_existing.writes_delta, 0) <> p_writes_delta
       or coalesce(v_existing.reads_delta, 0) <> p_reads_delta
       or coalesce(v_existing.embeds_delta, 0) <> p_embeds_delta
       or coalesce(v_existing.embed_tokens_delta, 0) <> p_embed_tokens_delta
       or coalesce(v_existing.extraction_calls_delta, 0) <> p_extraction_calls_delta then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return query
    select v_existing.id, false, null::text, 0::numeric, 0::numeric, true;
    return;
  end if;

  select
    e.entitlement_id,
    e.plan_id,
    e.period_start,
    e.period_end,
    e.budget_cap_inr,
    e.hard_cap_enabled,
    e.daily_usage_pct_cap
  into
    v_entitlement_id,
    v_plan.id,
    v_period_start,
    v_period_end,
    v_budget_cap,
    v_hard_cap_enabled,
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
  if coalesce(p_extraction_calls_cap, 0) = 0 then
    p_extraction_calls_cap := coalesce(v_plan.included_extraction_calls, 0);
  end if;
  if coalesce(p_embeds_cap, 0) = 0 then
    p_embeds_cap := greatest(1, floor(p_embed_tokens_cap / 200.0)::bigint);
  end if;
  if coalesce(p_storage_bytes_cap, 0) = 0 then
    p_storage_bytes_cap := floor(v_plan.included_storage_gb * 1000000000.0)::bigint;
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

  if not found then
    v_writes := 0;
    v_reads := 0;
    v_embeds := 0;
    v_extraction_calls := 0;
    v_embed_tokens := 0;
    v_gen_input_tokens := 0;
    v_gen_output_tokens := 0;
    v_storage_bytes := 0;
  end if;

  select
    coalesce(sum(r.writes_delta), 0),
    coalesce(sum(r.reads_delta), 0),
    coalesce(sum(r.embeds_delta), 0),
    coalesce(sum(r.extraction_calls_delta), 0),
    coalesce(sum(r.embed_tokens_delta), 0),
    coalesce(sum(r.estimated_cost_inr), 0)
  into
    v_reserved_writes,
    v_reserved_reads,
    v_reserved_embeds,
    v_reserved_extraction_calls,
    v_reserved_embed_tokens,
    v_reserved_budget_inr
  from usage_reservations r
  where r.workspace_id = p_workspace_id
    and r.status = 'reserved'
    and coalesce(r.expires_at, r.created_at + interval '30 minutes') > now()
    and r.request_id is distinct from p_request_id;

  if coalesce(p_cost_per_minute_cap_inr, 0) > 0 then
    if (
      coalesce((
        select sum(ue.estimated_cost_inr)
        from usage_events ue
        where ue.workspace_id = p_workspace_id
          and ue.event_ts >= now() - interval '1 minute'
      ), 0)
      + v_reserved_budget_inr
      + p_estimated_cost_inr
    ) > p_cost_per_minute_cap_inr then
      return query
      select null::uuid, true, 'cost_per_minute',
        (
          coalesce((
            select sum(ue.estimated_cost_inr)
            from usage_events ue
            where ue.workspace_id = p_workspace_id
              and ue.event_ts >= now() - interval '1 minute'
          ), 0)
          + v_reserved_budget_inr
        )::numeric,
        p_cost_per_minute_cap_inr::numeric,
        false;
      return;
    end if;
  end if;

  if v_hard_cap_enabled and (v_writes + v_reserved_writes + p_writes_delta > p_writes_cap) then
    return query select null::uuid, true, 'writes', (v_writes + v_reserved_writes)::numeric, p_writes_cap::numeric, false;
    return;
  end if;
  if v_hard_cap_enabled and (v_reads + v_reserved_reads + p_reads_delta > p_reads_cap) then
    return query select null::uuid, true, 'reads', (v_reads + v_reserved_reads)::numeric, p_reads_cap::numeric, false;
    return;
  end if;
  if v_hard_cap_enabled and (v_embeds + v_reserved_embeds + p_embeds_delta > p_embeds_cap) then
    return query select null::uuid, true, 'embeds', (v_embeds + v_reserved_embeds)::numeric, p_embeds_cap::numeric, false;
    return;
  end if;
  if v_hard_cap_enabled and (v_embed_tokens + v_reserved_embed_tokens + p_embed_tokens_delta > p_embed_tokens_cap) then
    return query select null::uuid, true, 'embed_tokens', (v_embed_tokens + v_reserved_embed_tokens)::numeric, p_embed_tokens_cap::numeric, false;
    return;
  end if;
  if v_hard_cap_enabled and (v_extraction_calls + v_reserved_extraction_calls + p_extraction_calls_delta > p_extraction_calls_cap) then
    return query select null::uuid, true, 'extraction_calls', (v_extraction_calls + v_reserved_extraction_calls)::numeric, p_extraction_calls_cap::numeric, false;
    return;
  end if;

  v_reserved_gen_tokens := 0;
  v_reserved_storage_bytes := 0;
  if v_hard_cap_enabled and (v_gen_input_tokens + v_gen_output_tokens + v_reserved_gen_tokens > p_gen_tokens_cap) then
    return query select null::uuid, true, 'gen_tokens', (v_gen_input_tokens + v_gen_output_tokens + v_reserved_gen_tokens)::numeric, p_gen_tokens_cap::numeric, false;
    return;
  end if;
  if v_hard_cap_enabled and (v_storage_bytes + v_reserved_storage_bytes > p_storage_bytes_cap) then
    return query select null::uuid, true, 'storage_bytes', (v_storage_bytes + v_reserved_storage_bytes)::numeric, p_storage_bytes_cap::numeric, false;
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

    if (v_budget_used + v_reserved_budget_inr + p_estimated_cost_inr) > v_budget_cap then
      return query select null::uuid, true, 'budget', (v_budget_used + v_reserved_budget_inr), v_budget_cap::numeric, false;
      return;
    end if;
  end if;

  insert into usage_reservations (
    workspace_id,
    day,
    writes_delta,
    reads_delta,
    embeds_delta,
    embed_tokens_delta,
    extraction_calls_delta,
    estimated_cost_inr,
    internal_credits_total,
    route,
    request_id,
    idempotency_key,
    status,
    expires_at
  ) values (
    p_workspace_id,
    v_day,
    p_writes_delta,
    p_reads_delta,
    p_embeds_delta,
    p_embed_tokens_delta,
    p_extraction_calls_delta,
    p_estimated_cost_inr,
    p_internal_credits_total,
    p_route,
    p_request_id,
    p_route || ':' || p_request_id,
    'reserved',
    now() + interval '30 minutes'
  )
  returning id into reservation_id;

  return query select reservation_id, false, null::text, 0::numeric, 0::numeric, false;
end;
$$;

create or replace function public.commit_usage_reservation(
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row usage_reservations%rowtype;
  v_usage_event_id uuid;
begin
  if p_reservation_id is null then
    return false;
  end if;

  select *
    into v_row
  from usage_reservations
  where id = p_reservation_id
  for update;

  if not found then
    return false;
  end if;

  if v_row.status = 'committed' then
    return true;
  end if;
  if v_row.status not in ('reserved', 'refund_pending') then
    return false;
  end if;

  if v_row.idempotency_key is null or length(trim(v_row.idempotency_key)) = 0 then
    v_row.idempotency_key := 'reservation:' || v_row.id::text;
  end if;

  insert into usage_events (
    workspace_id,
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
    abuse_flags,
    metadata
  ) values (
    v_row.workspace_id,
    (v_row.day::text || ' 00:00:00+00')::timestamptz,
    v_row.request_id,
    v_row.idempotency_key,
    coalesce(v_row.route, 'unknown'),
    'api_key',
    null,
    coalesce(v_row.writes_delta, 0),
    coalesce(v_row.reads_delta, 0),
    coalesce(v_row.embeds_delta, 0),
    coalesce(v_row.extraction_calls_delta, 0),
    coalesce(v_row.embed_tokens_delta, 0),
    0,
    0,
    0,
    coalesce(v_row.estimated_cost_inr, 0),
    true,
    '[]'::jsonb,
    jsonb_build_object(
      'reservation_id', v_row.id::text,
      'internal_credits_total', coalesce(v_row.internal_credits_total, 0)
    )
  )
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into v_usage_event_id;

  if v_usage_event_id is null then
    select id into v_usage_event_id
    from usage_events
    where workspace_id = v_row.workspace_id
      and idempotency_key = v_row.idempotency_key
    limit 1;
  else
    insert into usage_daily_v2 (
      workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens, gen_input_tokens, gen_output_tokens, storage_bytes, estimated_cost_inr, last_event_at, updated_at
    ) values (
      v_row.workspace_id, v_row.day, coalesce(v_row.writes_delta, 0), coalesce(v_row.reads_delta, 0), coalesce(v_row.embeds_delta, 0), coalesce(v_row.extraction_calls_delta, 0), coalesce(v_row.embed_tokens_delta, 0), 0, 0, 0, coalesce(v_row.estimated_cost_inr, 0), now(), now()
    )
    on conflict (workspace_id, day)
    do update set
      writes = usage_daily_v2.writes + excluded.writes,
      reads = usage_daily_v2.reads + excluded.reads,
      embeds = usage_daily_v2.embeds + excluded.embeds,
      extraction_calls = usage_daily_v2.extraction_calls + excluded.extraction_calls,
      embed_tokens = usage_daily_v2.embed_tokens + excluded.embed_tokens,
      estimated_cost_inr = usage_daily_v2.estimated_cost_inr + excluded.estimated_cost_inr,
      last_event_at = now(),
      updated_at = now();

    insert into usage_daily (workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens_used)
    values (v_row.workspace_id, v_row.day, coalesce(v_row.writes_delta, 0), coalesce(v_row.reads_delta, 0), coalesce(v_row.embeds_delta, 0), coalesce(v_row.extraction_calls_delta, 0), coalesce(v_row.embed_tokens_delta, 0))
    on conflict (workspace_id, day)
    do update set
      writes = usage_daily.writes + excluded.writes,
      reads = usage_daily.reads + excluded.reads,
      embeds = usage_daily.embeds + excluded.embeds,
      extraction_calls = usage_daily.extraction_calls + excluded.extraction_calls,
      embed_tokens_used = usage_daily.embed_tokens_used + excluded.embed_tokens_used;
  end if;

  update usage_reservations
  set
    status = 'committed',
    usage_event_id = coalesce(v_usage_event_id, usage_event_id),
    committed_at = coalesce(committed_at, now()),
    idempotency_key = v_row.idempotency_key,
    updated_at = now()
  where id = v_row.id;

  return true;
end;
$$;

create or replace function public.process_usage_reservation_refunds(
  p_limit int default 100
)
returns table (
  reservation_id uuid,
  workspace_id uuid,
  day date,
  status text,
  error_message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row usage_reservations%rowtype;
  v_limit int;
begin
  v_limit := greatest(1, least(coalesce(p_limit, 100), 1000));

  update usage_reservations
  set
    status = 'refund_pending',
    updated_at = now(),
    error_message = coalesce(error_message, 'reservation_expired')
  where status = 'reserved'
    and coalesce(expires_at, created_at + interval '30 minutes') <= now();

  for v_row in
    select *
    from usage_reservations
    where status = 'refund_pending'
    order by created_at asc
    limit v_limit
    for update skip locked
  loop
    update usage_reservations
    set
      status = 'refunded',
      refunded_at = now(),
      attempts = attempts + 1,
      last_attempt_at = now(),
      updated_at = now()
    where id = v_row.id;

    reservation_id := v_row.id;
    workspace_id := v_row.workspace_id;
    day := v_row.day;
    status := 'refunded';
    error_message := null;
    return next;
  end loop;
end;
$$;

create or replace function public.reconcile_usage_aggregates(
  p_workspace_id uuid default null,
  p_day date default null,
  p_limit int default 100
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint := 0;
  v_row record;
begin
  for v_row in
    select
      ue.workspace_id,
      (ue.event_ts at time zone 'utc')::date as day,
      coalesce(sum(ue.writes_delta), 0)::bigint as writes,
      coalesce(sum(ue.reads_delta), 0)::bigint as reads,
      coalesce(sum(ue.embeds_delta), 0)::bigint as embeds,
      coalesce(sum(ue.extraction_calls_delta), 0)::bigint as extraction_calls,
      coalesce(sum(ue.embed_tokens_delta), 0)::bigint as embed_tokens,
      coalesce(sum(ue.gen_input_tokens_delta), 0)::bigint as gen_input_tokens,
      coalesce(sum(ue.gen_output_tokens_delta), 0)::bigint as gen_output_tokens,
      coalesce(sum(ue.storage_bytes_delta), 0)::bigint as storage_bytes,
      coalesce(sum(ue.estimated_cost_inr), 0)::numeric(20,6) as estimated_cost_inr
    from usage_events ue
    where (p_workspace_id is null or ue.workspace_id = p_workspace_id)
      and (p_day is null or (ue.event_ts at time zone 'utc')::date = p_day)
    group by ue.workspace_id, (ue.event_ts at time zone 'utc')::date
    limit greatest(1, least(coalesce(p_limit, 100), 1000))
  loop
    insert into usage_daily_v2 (
      workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens, gen_input_tokens, gen_output_tokens, storage_bytes, estimated_cost_inr, last_event_at, updated_at
    ) values (
      v_row.workspace_id, v_row.day, v_row.writes, v_row.reads, v_row.embeds, v_row.extraction_calls, v_row.embed_tokens, v_row.gen_input_tokens, v_row.gen_output_tokens, v_row.storage_bytes, v_row.estimated_cost_inr, now(), now()
    )
    on conflict (workspace_id, day)
    do update set
      writes = excluded.writes,
      reads = excluded.reads,
      embeds = excluded.embeds,
      extraction_calls = excluded.extraction_calls,
      embed_tokens = excluded.embed_tokens,
      gen_input_tokens = excluded.gen_input_tokens,
      gen_output_tokens = excluded.gen_output_tokens,
      storage_bytes = excluded.storage_bytes,
      estimated_cost_inr = excluded.estimated_cost_inr,
      last_event_at = now(),
      updated_at = now();

    insert into usage_daily (workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens_used)
    values (
      v_row.workspace_id, v_row.day, v_row.writes, v_row.reads, v_row.embeds, v_row.extraction_calls, v_row.embed_tokens
    )
    on conflict (workspace_id, day)
    do update set
      writes = excluded.writes,
      reads = excluded.reads,
      embeds = excluded.embeds,
      extraction_calls = excluded.extraction_calls,
      embed_tokens_used = excluded.embed_tokens_used;

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.reserve_usage_if_within_cap(uuid, date, text, text, int, int, int, int, int, numeric, bigint, numeric, bigint, bigint, bigint, bigint, bigint, bigint, bigint) from public;
revoke all on function public.commit_usage_reservation(uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.reserve_usage_if_within_cap(uuid, date, text, text, int, int, int, int, int, numeric, bigint, numeric, bigint, bigint, bigint, bigint, bigint, bigint, bigint) to service_role';
    execute 'grant execute on function public.commit_usage_reservation(uuid) to service_role';
    execute 'grant execute on function public.reconcile_usage_aggregates(uuid, date, int) to service_role';
  end if;
end $$;
