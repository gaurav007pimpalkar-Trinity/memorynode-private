-- 038_usage_events_ledger.sql
-- Immutable usage ledger + atomic reserve RPC with idempotency.

set search_path = public;

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entitlement_id bigint references entitlements(id) on delete set null,
  event_ts timestamptz not null default now(),
  event_day date generated always as ((event_ts at time zone 'utc')::date) stored,
  request_id text,
  idempotency_key text not null,
  route text not null default 'unknown',
  actor_type text not null default 'system',
  actor_id text,
  writes_delta int not null default 0,
  reads_delta int not null default 0,
  embeds_delta int not null default 0,
  extraction_calls_delta int not null default 0,
  embed_tokens_delta bigint not null default 0,
  gen_input_tokens_delta bigint not null default 0,
  gen_output_tokens_delta bigint not null default 0,
  storage_bytes_delta bigint not null default 0,
  estimated_cost_inr numeric(12,6) not null default 0,
  billable boolean not null default true,
  abuse_flags jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint usage_events_actor_type_check check (actor_type in ('api_key', 'user', 'system')),
  constraint usage_events_non_negative_delta_check check (
    writes_delta >= 0 and
    reads_delta >= 0 and
    embeds_delta >= 0 and
    extraction_calls_delta >= 0 and
    embed_tokens_delta >= 0 and
    gen_input_tokens_delta >= 0 and
    gen_output_tokens_delta >= 0
  ),
  constraint usage_events_abuse_flags_array_check check (jsonb_typeof(abuse_flags) = 'array'),
  constraint usage_events_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists usage_events_workspace_idempotency_idx
  on usage_events (workspace_id, idempotency_key);
create index if not exists usage_events_workspace_event_ts_idx
  on usage_events (workspace_id, event_ts desc);
create index if not exists usage_events_workspace_event_day_idx
  on usage_events (workspace_id, event_day);
create index if not exists usage_events_entitlement_event_ts_idx
  on usage_events (entitlement_id, event_ts);

create table if not exists usage_daily_v2 (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  day date not null,
  writes bigint not null default 0,
  reads bigint not null default 0,
  embeds bigint not null default 0,
  extraction_calls bigint not null default 0,
  embed_tokens bigint not null default 0,
  gen_input_tokens bigint not null default 0,
  gen_output_tokens bigint not null default 0,
  storage_bytes bigint not null default 0,
  estimated_cost_inr numeric(12,6) not null default 0,
  last_event_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, day)
);

create index if not exists usage_daily_v2_day_idx on usage_daily_v2 (day);

alter table if exists usage_events enable row level security;
alter table if exists usage_daily_v2 enable row level security;

drop policy if exists usage_events_select on usage_events;
drop policy if exists usage_events_modify on usage_events;
drop policy if exists usage_daily_v2_select on usage_daily_v2;
drop policy if exists usage_daily_v2_modify on usage_daily_v2;

create policy usage_events_select on usage_events
  for select using (
    auth.role() = 'service_role'
    or exists (
      select 1 from workspace_members m
      where m.workspace_id = usage_events.workspace_id and m.user_id = auth.uid()
    )
  );

create policy usage_events_modify on usage_events
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy usage_daily_v2_select on usage_daily_v2
  for select using (
    auth.role() = 'service_role'
    or exists (
      select 1 from workspace_members m
      where m.workspace_id = usage_daily_v2.workspace_id and m.user_id = auth.uid()
    )
  );

create policy usage_daily_v2_modify on usage_daily_v2
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function resolve_active_entitlement(
  p_workspace_id uuid,
  p_at timestamptz default now()
)
returns table (
  entitlement_id bigint,
  plan_id bigint,
  plan_code text,
  period_start timestamptz,
  period_end timestamptz,
  budget_cap_inr numeric(12,2),
  hard_cap_enabled boolean,
  soft_cap_enabled boolean,
  daily_usage_pct_cap numeric(5,2)
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id as entitlement_id,
    p.id as plan_id,
    p.plan_code,
    e.period_start,
    e.period_end,
    e.budget_cap_inr,
    e.hard_cap_enabled,
    e.soft_cap_enabled,
    p.daily_usage_pct_cap
  from entitlements e
  join plans p on p.id = e.plan_id
  where e.workspace_id = p_workspace_id
    and e.status in ('active', 'grace')
    and e.period_start <= p_at
    and e.period_end > p_at
  order by e.period_end desc, e.created_at desc
  limit 1;
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

  select e.entitlement_id
    into v_entitlement_id
  from resolve_active_entitlement(p_workspace_id, now()) e
  limit 1;

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
      v_writes,
      v_reads,
      v_embeds,
      v_extraction_calls,
      v_embed_tokens,
      v_gen_input_tokens,
      v_gen_output_tokens,
      v_storage_bytes
    from usage_daily_v2 u
    where u.workspace_id = p_workspace_id and u.day = v_day
    for update;

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
      v_existing_event,
      v_entitlement_id,
      true::boolean;
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
    v_writes,
    v_reads,
    v_embeds,
    v_extraction_calls,
    v_embed_tokens,
    v_gen_input_tokens,
    v_gen_output_tokens,
    v_storage_bytes
  from usage_daily_v2 u
  where u.workspace_id = p_workspace_id and u.day = v_day
  for update;

  if (v_writes + p_writes) > coalesce(nullif(p_writes_cap, 0), 9223372036854775807) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'writes', null::uuid, v_entitlement_id, false;
    return;
  end if;
  if (v_reads + p_reads) > coalesce(nullif(p_reads_cap, 0), 9223372036854775807) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'reads', null::uuid, v_entitlement_id, false;
    return;
  end if;
  if (v_embeds + p_embeds) > coalesce(nullif(p_embeds_cap, 0), 9223372036854775807) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'embeds', null::uuid, v_entitlement_id, false;
    return;
  end if;
  if (v_embed_tokens + p_embed_tokens) > coalesce(nullif(p_embed_tokens_cap, 0), 9223372036854775807) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'embed_tokens', null::uuid, v_entitlement_id, false;
    return;
  end if;
  if (v_extraction_calls + p_extraction_calls) > coalesce(nullif(p_extraction_calls_cap, 0), 9223372036854775807) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'extraction_calls', null::uuid, v_entitlement_id, false;
    return;
  end if;
  if ((v_gen_input_tokens + v_gen_output_tokens + p_gen_input_tokens + p_gen_output_tokens) > coalesce(nullif(p_gen_tokens_cap, 0), 9223372036854775807)) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'gen_tokens', null::uuid, v_entitlement_id, false;
    return;
  end if;
  if (greatest(0, v_storage_bytes + p_storage_bytes)) > coalesce(nullif(p_storage_bytes_cap, 0), 9223372036854775807) then
    return query select p_workspace_id, v_day, v_writes, v_reads, v_embeds, v_extraction_calls, v_embed_tokens, v_gen_input_tokens, v_gen_output_tokens, v_storage_bytes, true, 'storage_bytes', null::uuid, v_entitlement_id, false;
    return;
  end if;

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
  values (
    p_workspace_id,
    v_entitlement_id,
    (v_day::text || ' 00:00:00+00')::timestamptz,
    p_request_id,
    p_idempotency_key,
    p_route,
    p_actor_type,
    p_actor_id,
    p_writes,
    p_reads,
    p_embeds,
    p_extraction_calls,
    p_embed_tokens,
    p_gen_input_tokens,
    p_gen_output_tokens,
    p_storage_bytes,
    p_estimated_cost_inr,
    p_billable,
    p_metadata
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
      v_existing_event,
      v_entitlement_id,
      true::boolean;
    return;
  end if;

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
  values (
    p_workspace_id,
    v_day,
    p_writes,
    p_reads,
    p_embeds,
    p_extraction_calls,
    p_embed_tokens,
    p_gen_input_tokens,
    p_gen_output_tokens,
    p_storage_bytes,
    p_estimated_cost_inr,
    now(),
    now()
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

  -- Dual-write bridge for existing dashboards and handlers.
  insert into usage_daily (workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens_used)
  values (
    p_workspace_id,
    v_day,
    p_writes,
    p_reads,
    p_embeds,
    p_extraction_calls,
    p_embed_tokens
  )
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
    v_writes,
    v_reads,
    v_embeds,
    v_extraction_calls,
    v_embed_tokens,
    v_gen_input_tokens,
    v_gen_output_tokens,
    v_storage_bytes
  from usage_daily_v2 u
  where u.workspace_id = p_workspace_id and u.day = v_day;

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

revoke all on table usage_events from public;
revoke all on table usage_daily_v2 from public;
revoke all on function resolve_active_entitlement(uuid, timestamptz) from public;
revoke all on function record_usage_event_if_within_cap(
  uuid, date, text, text, text, text, text, int, int, int, bigint, int, bigint, bigint, bigint, numeric, boolean, jsonb, bigint, bigint, bigint, bigint, bigint, bigint, bigint
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on table usage_events to authenticated';
    execute 'grant select on table usage_daily_v2 to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table usage_events to service_role';
    execute 'grant all on table usage_daily_v2 to service_role';
    execute 'grant execute on function resolve_active_entitlement(uuid, timestamptz) to service_role';
    execute 'grant execute on function record_usage_event_if_within_cap(
      uuid, date, text, text, text, text, text, int, int, int, bigint, int, bigint, bigint, bigint, numeric, boolean, jsonb, bigint, bigint, bigint, bigint, bigint, bigint, bigint
    ) to service_role';
  end if;
end $$;
