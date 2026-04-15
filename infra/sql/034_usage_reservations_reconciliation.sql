-- 034_usage_reservations_reconciliation.sql
-- Async quota refund reconciliation for post-reservation failures.

set search_path = public;

create table if not exists usage_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  day date not null,
  writes_delta int not null default 0,
  reads_delta int not null default 0,
  embeds_delta int not null default 0,
  embed_tokens_delta int not null default 0,
  extraction_calls_delta int not null default 0,
  route text,
  request_id text,
  status text not null default 'reserved',
  error_message text,
  attempts int not null default 0,
  last_attempt_at timestamptz,
  committed_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint usage_reservations_status_check
    check (status in ('reserved', 'committed', 'refund_pending', 'refunded', 'failed')),
  constraint usage_reservations_deltas_non_negative
    check (
      writes_delta >= 0 and
      reads_delta >= 0 and
      embeds_delta >= 0 and
      embed_tokens_delta >= 0 and
      extraction_calls_delta >= 0
    )
);

create index if not exists usage_reservations_status_created_idx
  on usage_reservations (status, created_at);
create index if not exists usage_reservations_workspace_day_idx
  on usage_reservations (workspace_id, day);
create index if not exists usage_reservations_request_idx
  on usage_reservations (request_id);

alter table if exists usage_reservations enable row level security;

drop policy if exists usage_reservations_select on usage_reservations;
drop policy if exists usage_reservations_modify on usage_reservations;

create policy usage_reservations_select on usage_reservations
  for select using (
    auth.role() = 'service_role'
    or exists (
      select 1 from workspace_members m
      where m.workspace_id = usage_reservations.workspace_id and m.user_id = auth.uid()
    )
  );

create policy usage_reservations_modify on usage_reservations
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

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
begin
  insert into usage_reservations (
    workspace_id,
    day,
    writes_delta,
    reads_delta,
    embeds_delta,
    embed_tokens_delta,
    extraction_calls_delta,
    route,
    request_id,
    status
  )
  values (
    p_workspace_id,
    p_day,
    coalesce(p_writes_delta, 0),
    coalesce(p_reads_delta, 0),
    coalesce(p_embeds_delta, 0),
    coalesce(p_embed_tokens_delta, 0),
    coalesce(p_extraction_calls_delta, 0),
    p_route,
    p_request_id,
    'reserved'
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.mark_usage_reservation_committed(
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update usage_reservations
    set
      status = 'committed',
      committed_at = now(),
      updated_at = now()
  where id = p_reservation_id
    and status in ('reserved', 'refund_pending');
  return found;
end;
$$;

create or replace function public.mark_usage_reservation_refund_pending(
  p_reservation_id uuid,
  p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update usage_reservations
    set
      status = 'refund_pending',
      error_message = coalesce(p_error_message, error_message),
      updated_at = now()
  where id = p_reservation_id
    and status = 'reserved';
  return found;
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

revoke all on function public.create_usage_reservation(uuid, date, int, int, int, int, int, text, text) from public;
revoke all on function public.mark_usage_reservation_committed(uuid) from public;
revoke all on function public.mark_usage_reservation_refund_pending(uuid, text) from public;
revoke all on function public.process_usage_reservation_refunds(int) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.create_usage_reservation(uuid, date, int, int, int, int, int, text, text) to service_role';
    execute 'grant execute on function public.mark_usage_reservation_committed(uuid) to service_role';
    execute 'grant execute on function public.mark_usage_reservation_refund_pending(uuid, text) to service_role';
    execute 'grant execute on function public.process_usage_reservation_refunds(int) to service_role';
  end if;
end $$;
