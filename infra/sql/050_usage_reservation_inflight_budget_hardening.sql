-- 050_usage_reservation_inflight_budget_hardening.sql
-- Strengthen reservation accounting with TTL/in-flight visibility and stricter
-- SQL-side estimated-cost enforcement for billable usage events.

set search_path = public;

alter table if exists usage_reservations
  add column if not exists estimated_cost_inr numeric(12,6) not null default 0,
  add column if not exists expires_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'usage_reservations_estimated_cost_non_negative'
  ) then
    alter table usage_reservations
      add constraint usage_reservations_estimated_cost_non_negative
      check (estimated_cost_inr >= 0);
  end if;
end $$;

update usage_reservations
set expires_at = created_at + interval '30 minutes'
where expires_at is null;

create index if not exists usage_reservations_status_expires_idx
  on usage_reservations (status, expires_at);

create or replace function public.estimate_usage_reservation_cost_inr(
  p_writes_delta int,
  p_reads_delta int,
  p_embed_tokens_delta int,
  p_extraction_calls_delta int
)
returns numeric(12,6)
language sql
immutable
as $$
  with c as (
    select
      greatest(0, coalesce(p_writes_delta, 0))::numeric as writes_delta,
      greatest(0, coalesce(p_reads_delta, 0))::numeric as reads_delta,
      greatest(0, coalesce(p_embed_tokens_delta, 0))::numeric as embed_tokens_delta,
      greatest(0, coalesce(p_extraction_calls_delta, 0))::numeric as extraction_calls_delta
  )
  select round(
    (
      ((embed_tokens_delta / 1000.0) * 0.001660::numeric) +  -- $0.00002/1k * 83 INR/USD
      (extraction_calls_delta * 0.012450::numeric) +          -- $0.00015/call * 83 INR/USD
      (reads_delta * 0.000500::numeric) +
      (writes_delta * 0.002000::numeric)
    ) * 1.35::numeric,
    6
  )::numeric(12,6)
  from c;
$$;

create or replace function public.create_usage_reservation(
  p_workspace_id uuid,
  p_day date,
  p_writes_delta int,
  p_reads_delta int,
  p_embeds_delta int,
  p_embed_tokens_delta int,
  p_extraction_calls_delta int,
  p_route text default null,
  p_request_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_estimated_cost numeric(12,6);
begin
  v_estimated_cost := estimate_usage_reservation_cost_inr(
    p_writes_delta,
    p_reads_delta,
    p_embed_tokens_delta,
    p_extraction_calls_delta
  );

  insert into usage_reservations (
    workspace_id,
    day,
    writes_delta,
    reads_delta,
    embeds_delta,
    embed_tokens_delta,
    extraction_calls_delta,
    estimated_cost_inr,
    route,
    request_id,
    status,
    expires_at
  )
  values (
    p_workspace_id,
    p_day,
    coalesce(p_writes_delta, 0),
    coalesce(p_reads_delta, 0),
    coalesce(p_embeds_delta, 0),
    coalesce(p_embed_tokens_delta, 0),
    coalesce(p_extraction_calls_delta, 0),
    greatest(0, coalesce(v_estimated_cost, 0)),
    p_route,
    p_request_id,
    'reserved',
    now() + interval '30 minutes'
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.get_workspace_inflight_usage(
  p_workspace_id uuid
)
returns table (
  reserved_requests bigint,
  reserved_estimated_cost_inr numeric(20,6),
  oldest_reserved_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::bigint as reserved_requests,
    coalesce(sum(r.estimated_cost_inr), 0)::numeric(20,6) as reserved_estimated_cost_inr,
    min(r.created_at) as oldest_reserved_at
  from usage_reservations r
  where r.workspace_id = p_workspace_id
    and r.status = 'reserved'
    and coalesce(r.expires_at, r.created_at + interval '30 minutes') > now();
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
    begin
      update usage_daily
      set
        writes = greatest(0, writes - coalesce(v_row.writes_delta, 0)),
        reads = greatest(0, reads - coalesce(v_row.reads_delta, 0)),
        embeds = greatest(0, embeds - coalesce(v_row.embeds_delta, 0)),
        extraction_calls = greatest(0, extraction_calls - coalesce(v_row.extraction_calls_delta, 0)),
        embed_tokens_used = greatest(0, embed_tokens_used - coalesce(v_row.embed_tokens_delta, 0))
      where usage_daily.workspace_id = v_row.workspace_id
        and usage_daily.day = v_row.day;

      update usage_daily_v2
      set
        writes = greatest(0, writes - coalesce(v_row.writes_delta, 0)),
        reads = greatest(0, reads - coalesce(v_row.reads_delta, 0)),
        embeds = greatest(0, embeds - coalesce(v_row.embeds_delta, 0)),
        extraction_calls = greatest(0, extraction_calls - coalesce(v_row.extraction_calls_delta, 0)),
        embed_tokens = greatest(0, embed_tokens - coalesce(v_row.embed_tokens_delta, 0)),
        estimated_cost_inr = greatest(0, estimated_cost_inr - coalesce(v_row.estimated_cost_inr, 0)),
        updated_at = now()
      where usage_daily_v2.workspace_id = v_row.workspace_id
        and usage_daily_v2.day = v_row.day;

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
    exception
      when others then
        update usage_reservations
        set
          status = case when attempts + 1 >= 5 then 'failed' else 'refund_pending' end,
          attempts = attempts + 1,
          last_attempt_at = now(),
          updated_at = now(),
          error_message = left(coalesce(sqlerrm, 'refund_failed'), 500)
        where id = v_row.id;

        reservation_id := v_row.id;
        workspace_id := v_row.workspace_id;
        day := v_row.day;
        status := 'failed';
        error_message := left(coalesce(sqlerrm, 'refund_failed'), 500);
        return next;
    end;
  end loop;
end;
$$;

create or replace function public.enforce_usage_event_estimated_cost()
returns trigger
language plpgsql
as $$
begin
  if coalesce(new.billable, true)
     and coalesce(new.estimated_cost_inr, 0) <= 0
     and (
       coalesce(new.writes_delta, 0) > 0
       or coalesce(new.reads_delta, 0) > 0
       or coalesce(new.embed_tokens_delta, 0) > 0
       or coalesce(new.extraction_calls_delta, 0) > 0
       or coalesce(new.gen_input_tokens_delta, 0) > 0
       or coalesce(new.gen_output_tokens_delta, 0) > 0
       or coalesce(new.storage_bytes_delta, 0) > 0
     ) then
    raise exception 'estimated_cost_inr must be > 0 for billable usage events with non-zero deltas';
  end if;
  return new;
end;
$$;

drop trigger if exists usage_events_estimated_cost_guard on usage_events;
create trigger usage_events_estimated_cost_guard
before insert or update on usage_events
for each row
execute function public.enforce_usage_event_estimated_cost();

revoke all on function public.estimate_usage_reservation_cost_inr(int, int, int, int) from public;
revoke all on function public.get_workspace_inflight_usage(uuid) from public;
revoke all on function public.enforce_usage_event_estimated_cost() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.get_workspace_inflight_usage(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.estimate_usage_reservation_cost_inr(int, int, int, int) to service_role';
    execute 'grant execute on function public.get_workspace_inflight_usage(uuid) to service_role';
    execute 'grant execute on function public.create_usage_reservation(uuid, date, int, int, int, int, int, text, text) to service_role';
    execute 'grant execute on function public.process_usage_reservation_refunds(int) to service_role';
  end if;
end $$;
