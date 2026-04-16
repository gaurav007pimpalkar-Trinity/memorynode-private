-- 039_invoice_lines_overage.sql
-- Invoice line materialization for base plan + overages.

set search_path = public;

create table if not exists invoice_lines (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entitlement_id bigint references entitlements(id) on delete set null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  line_type text not null,
  metric text,
  quantity numeric(20,6) not null default 0,
  unit_price_inr numeric(20,6) not null default 0,
  amount_inr numeric(20,2) not null,
  currency text not null default 'INR',
  status text not null default 'open',
  source_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint invoice_lines_line_type_check check (
    line_type in (
      'base_plan',
      'overage_writes',
      'overage_reads',
      'overage_embed_tokens',
      'overage_gen_tokens',
      'overage_storage',
      'credit',
      'adjustment',
      'tax'
    )
  ),
  constraint invoice_lines_status_check check (status in ('open', 'finalized', 'void')),
  constraint invoice_lines_period_check check (period_end > period_start),
  constraint invoice_lines_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists invoice_lines_workspace_period_idx
  on invoice_lines (workspace_id, period_start, period_end);
create index if not exists invoice_lines_entitlement_type_idx
  on invoice_lines (entitlement_id, line_type);
create index if not exists invoice_lines_status_created_idx
  on invoice_lines (status, created_at);

alter table if exists invoice_lines enable row level security;

drop policy if exists invoice_lines_select on invoice_lines;
drop policy if exists invoice_lines_modify on invoice_lines;

create policy invoice_lines_select on invoice_lines
  for select using (
    auth.role() = 'service_role'
    or exists (
      select 1 from workspace_members m
      where m.workspace_id = invoice_lines.workspace_id and m.user_id = auth.uid()
    )
  );

create policy invoice_lines_modify on invoice_lines
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function compute_period_usage(
  p_workspace_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_entitlement_id bigint default null
)
returns table (
  writes bigint,
  reads bigint,
  embed_tokens bigint,
  gen_tokens bigint,
  storage_bytes bigint,
  estimated_cost_inr numeric(12,6)
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(ue.writes_delta), 0)::bigint as writes,
    coalesce(sum(ue.reads_delta), 0)::bigint as reads,
    coalesce(sum(ue.embed_tokens_delta), 0)::bigint as embed_tokens,
    coalesce(sum(ue.gen_input_tokens_delta + ue.gen_output_tokens_delta), 0)::bigint as gen_tokens,
    coalesce(sum(ue.storage_bytes_delta), 0)::bigint as storage_bytes,
    coalesce(sum(ue.estimated_cost_inr), 0)::numeric(12,6) as estimated_cost_inr
  from usage_events ue
  where ue.workspace_id = p_workspace_id
    and ue.billable = true
    and ue.event_ts >= p_period_start
    and ue.event_ts < p_period_end
    and (p_entitlement_id is null or ue.entitlement_id = p_entitlement_id);
$$;

create or replace function build_invoice_lines_for_period(
  p_workspace_id uuid,
  p_entitlement_id bigint,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_finalize boolean default false
)
returns table (
  id bigint,
  line_type text,
  amount_inr numeric(20,2)
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan plans%rowtype;
  v_writes bigint := 0;
  v_reads bigint := 0;
  v_embed_tokens bigint := 0;
  v_gen_tokens bigint := 0;
  v_storage_bytes bigint := 0;
  v_cost numeric(12,6) := 0;
  v_line_status text := 'open';
begin
  if p_workspace_id is null or p_period_start is null or p_period_end is null then
    raise exception 'workspace_id and period bounds are required';
  end if;
  if p_period_end <= p_period_start then
    raise exception 'period_end must be greater than period_start';
  end if;
  if p_finalize then
    v_line_status := 'finalized';
  end if;

  if p_entitlement_id is null then
    select p.*
      into v_plan
    from plans p
    where p.plan_code = 'launch'
    limit 1;
  else
    select p.*
      into v_plan
    from entitlements e
    join plans p on p.id = e.plan_id
    where e.id = p_entitlement_id
    limit 1;
  end if;

  if v_plan.id is null then
    raise exception 'unable to resolve plan for invoice period';
  end if;

  select
    u.writes,
    u.reads,
    u.embed_tokens,
    u.gen_tokens,
    u.storage_bytes,
    u.estimated_cost_inr
  into
    v_writes,
    v_reads,
    v_embed_tokens,
    v_gen_tokens,
    v_storage_bytes,
    v_cost
  from compute_period_usage(p_workspace_id, p_period_start, p_period_end, p_entitlement_id) u;

  delete from invoice_lines il
  where il.workspace_id = p_workspace_id
    and il.period_start = p_period_start
    and il.period_end = p_period_end
    and il.status = 'open';

  insert into invoice_lines (
    workspace_id,
    entitlement_id,
    period_start,
    period_end,
    line_type,
    metric,
    quantity,
    unit_price_inr,
    amount_inr,
    currency,
    status,
    metadata
  )
  values (
    p_workspace_id,
    p_entitlement_id,
    p_period_start,
    p_period_end,
    'base_plan',
    'subscription',
    1,
    v_plan.price_inr,
    round(v_plan.price_inr, 2),
    v_plan.currency,
    v_line_status,
    jsonb_build_object('plan_code', v_plan.plan_code, 'included', true)
  );

  if v_writes > v_plan.included_writes then
    insert into invoice_lines (
      workspace_id, entitlement_id, period_start, period_end, line_type, metric,
      quantity, unit_price_inr, amount_inr, currency, status, metadata
    )
    values (
      p_workspace_id, p_entitlement_id, p_period_start, p_period_end, 'overage_writes', 'writes',
      (v_writes - v_plan.included_writes),
      (v_plan.overage_writes_per_1k_inr / 1000.0),
      round(((v_writes - v_plan.included_writes) * (v_plan.overage_writes_per_1k_inr / 1000.0))::numeric, 2),
      v_plan.currency,
      v_line_status,
      jsonb_build_object('included', v_plan.included_writes, 'actual', v_writes)
    );
  end if;

  if v_reads > v_plan.included_reads then
    insert into invoice_lines (
      workspace_id, entitlement_id, period_start, period_end, line_type, metric,
      quantity, unit_price_inr, amount_inr, currency, status, metadata
    )
    values (
      p_workspace_id, p_entitlement_id, p_period_start, p_period_end, 'overage_reads', 'reads',
      (v_reads - v_plan.included_reads),
      (v_plan.overage_reads_per_1k_inr / 1000.0),
      round(((v_reads - v_plan.included_reads) * (v_plan.overage_reads_per_1k_inr / 1000.0))::numeric, 2),
      v_plan.currency,
      v_line_status,
      jsonb_build_object('included', v_plan.included_reads, 'actual', v_reads)
    );
  end if;

  if v_embed_tokens > v_plan.included_embed_tokens then
    insert into invoice_lines (
      workspace_id, entitlement_id, period_start, period_end, line_type, metric,
      quantity, unit_price_inr, amount_inr, currency, status, metadata
    )
    values (
      p_workspace_id, p_entitlement_id, p_period_start, p_period_end, 'overage_embed_tokens', 'embed_tokens',
      (v_embed_tokens - v_plan.included_embed_tokens),
      (v_plan.overage_embed_tokens_per_1m_inr / 1000000.0),
      round(((v_embed_tokens - v_plan.included_embed_tokens) * (v_plan.overage_embed_tokens_per_1m_inr / 1000000.0))::numeric, 2),
      v_plan.currency,
      v_line_status,
      jsonb_build_object('included', v_plan.included_embed_tokens, 'actual', v_embed_tokens)
    );
  end if;

  if v_gen_tokens > v_plan.included_gen_tokens then
    insert into invoice_lines (
      workspace_id, entitlement_id, period_start, period_end, line_type, metric,
      quantity, unit_price_inr, amount_inr, currency, status, metadata
    )
    values (
      p_workspace_id, p_entitlement_id, p_period_start, p_period_end, 'overage_gen_tokens', 'gen_tokens',
      (v_gen_tokens - v_plan.included_gen_tokens),
      (v_plan.overage_gen_tokens_per_1m_inr / 1000000.0),
      round(((v_gen_tokens - v_plan.included_gen_tokens) * (v_plan.overage_gen_tokens_per_1m_inr / 1000000.0))::numeric, 2),
      v_plan.currency,
      v_line_status,
      jsonb_build_object('included', v_plan.included_gen_tokens, 'actual', v_gen_tokens)
    );
  end if;

  if (v_storage_bytes::numeric / 1000000000.0) > v_plan.included_storage_gb then
    insert into invoice_lines (
      workspace_id, entitlement_id, period_start, period_end, line_type, metric,
      quantity, unit_price_inr, amount_inr, currency, status, metadata
    )
    values (
      p_workspace_id, p_entitlement_id, p_period_start, p_period_end, 'overage_storage', 'storage_gb_month',
      ((v_storage_bytes::numeric / 1000000000.0) - v_plan.included_storage_gb),
      v_plan.overage_storage_gb_month_inr,
      round((((v_storage_bytes::numeric / 1000000000.0) - v_plan.included_storage_gb) * v_plan.overage_storage_gb_month_inr)::numeric, 2),
      v_plan.currency,
      v_line_status,
      jsonb_build_object('included', v_plan.included_storage_gb, 'actual_gb', (v_storage_bytes::numeric / 1000000000.0))
    );
  end if;

  return query
  select il.id, il.line_type, il.amount_inr
  from invoice_lines il
  where il.workspace_id = p_workspace_id
    and il.period_start = p_period_start
    and il.period_end = p_period_end
  order by il.id asc;
end;
$$;

revoke all on table invoice_lines from public;
revoke all on function compute_period_usage(uuid, timestamptz, timestamptz, bigint) from public;
revoke all on function build_invoice_lines_for_period(uuid, bigint, timestamptz, timestamptz, boolean) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on table invoice_lines to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table invoice_lines to service_role';
    execute 'grant usage, select on sequence invoice_lines_id_seq to service_role';
    execute 'grant execute on function compute_period_usage(uuid, timestamptz, timestamptz, bigint) to service_role';
    execute 'grant execute on function build_invoice_lines_for_period(uuid, bigint, timestamptz, timestamptz, boolean) to service_role';
  end if;
end $$;
