-- 037_plans_entitlements_v3.sql
-- Canonical pricing catalog + entitlement periods for billing v3.

set search_path = public;

create extension if not exists btree_gist;

create table if not exists plans (
  id bigserial primary key,
  plan_code text not null unique,
  display_name text not null,
  price_inr numeric(12,2) not null,
  currency text not null default 'INR',
  billing_cycle_days int not null,
  included_writes bigint not null default 0,
  included_reads bigint not null default 0,
  included_embed_tokens bigint not null default 0,
  included_gen_tokens bigint not null default 0,
  included_storage_gb numeric(10,3) not null default 0,
  included_extraction_calls bigint not null default 0,
  max_text_chars int not null default 12000,
  workspace_rpm int not null default 120,
  retention_days int not null default 30,
  daily_usage_pct_cap numeric(5,2) not null default 15.00,
  overage_writes_per_1k_inr numeric(12,4) not null default 0,
  overage_reads_per_1k_inr numeric(12,4) not null default 0,
  overage_embed_tokens_per_1m_inr numeric(12,4) not null default 0,
  overage_gen_tokens_per_1m_inr numeric(12,4) not null default 0,
  overage_storage_gb_month_inr numeric(12,4) not null default 0,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_plan_code_check check (plan_code in ('launch', 'build', 'deploy', 'scale', 'scale_plus')),
  constraint plans_price_check check (price_inr >= 0),
  constraint plans_cycle_days_check check (billing_cycle_days > 0 or plan_code = 'scale_plus'),
  constraint plans_daily_pct_check check (daily_usage_pct_cap > 0 and daily_usage_pct_cap <= 100),
  constraint plans_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create table if not exists entitlements (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  plan_id bigint not null references plans(id),
  status text not null default 'active',
  period_start timestamptz not null,
  period_end timestamptz not null,
  auto_renew boolean not null default true,
  source_txn_id text references payu_transactions(txn_id) on delete set null,
  billing_provider text not null default 'payu',
  hard_cap_enabled boolean not null default true,
  soft_cap_enabled boolean not null default true,
  budget_cap_inr numeric(12,2),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint entitlements_status_check check (status in ('active', 'grace', 'expired', 'revoked', 'scheduled')),
  constraint entitlements_period_check check (period_end > period_start),
  constraint entitlements_budget_check check (budget_cap_inr is null or budget_cap_inr >= 0),
  constraint entitlements_provider_check check (billing_provider in ('payu', 'legacy_stripe', 'manual')),
  constraint entitlements_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

alter table if exists payu_transactions
  add column if not exists plan_id bigint references plans(id) on delete set null;

create index if not exists plans_active_idx on plans (is_active);
create index if not exists entitlements_workspace_status_period_idx on entitlements (workspace_id, status, period_end);
create index if not exists entitlements_source_txn_idx on entitlements (source_txn_id);
create unique index if not exists entitlements_source_txn_unique_idx on entitlements (source_txn_id) where source_txn_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'entitlements_no_overlap_active'
  ) then
    alter table entitlements
      add constraint entitlements_no_overlap_active
      exclude using gist (
        workspace_id with =,
        tstzrange(period_start, period_end, '[)') with &&
      )
      where (status in ('active', 'grace'));
  end if;
end $$;

insert into plans (
  plan_code, display_name, price_inr, currency, billing_cycle_days,
  included_writes, included_reads, included_embed_tokens, included_gen_tokens, included_storage_gb,
  included_extraction_calls, max_text_chars, workspace_rpm, retention_days, daily_usage_pct_cap,
  overage_writes_per_1k_inr, overage_reads_per_1k_inr, overage_embed_tokens_per_1m_inr,
  overage_gen_tokens_per_1m_inr, overage_storage_gb_month_inr, is_active, metadata
) values
  (
    'launch', 'Launch', 399.00, 'INR', 7,
    250, 1000, 100000, 150000, 0.500,
    0, 12000, 120, 30, 15.00,
    90.0000, 120.0000, 60.0000, 220.0000, 35.0000, true,
    jsonb_build_object('audience', 'solo')
  ),
  (
    'build', 'Build', 999.00, 'INR', 30,
    1200, 4000, 600000, 1000000, 2.000,
    100, 15000, 120, 90, 15.00,
    75.0000, 100.0000, 50.0000, 180.0000, 30.0000, true,
    jsonb_build_object('audience', 'solo')
  ),
  (
    'deploy', 'Deploy', 2999.00, 'INR', 30,
    5000, 15000, 3000000, 5000000, 10.000,
    500, 20000, 120, 180, 15.00,
    60.0000, 80.0000, 40.0000, 140.0000, 25.0000, true,
    jsonb_build_object('audience', 'team')
  ),
  (
    'scale', 'Scale', 8999.00, 'INR', 30,
    20000, 60000, 12000000, 20000000, 50.000,
    2000, 25000, 300, 365, 15.00,
    50.0000, 65.0000, 35.0000, 110.0000, 20.0000, true,
    jsonb_build_object('audience', 'team')
  ),
  (
    'scale_plus', 'Scale+', 0.00, 'INR', 30,
    100000, 200000, 200000000, 200000000, 250.000,
    5000, 50000, 300, 365, 20.00,
    40.0000, 55.0000, 30.0000, 95.0000, 18.0000, false,
    jsonb_build_object('audience', 'legacy', 'custom_pricing', true)
  )
on conflict (plan_code) do update set
  display_name = excluded.display_name,
  price_inr = excluded.price_inr,
  currency = excluded.currency,
  billing_cycle_days = excluded.billing_cycle_days,
  included_writes = excluded.included_writes,
  included_reads = excluded.included_reads,
  included_embed_tokens = excluded.included_embed_tokens,
  included_gen_tokens = excluded.included_gen_tokens,
  included_storage_gb = excluded.included_storage_gb,
  included_extraction_calls = excluded.included_extraction_calls,
  max_text_chars = excluded.max_text_chars,
  workspace_rpm = excluded.workspace_rpm,
  retention_days = excluded.retention_days,
  daily_usage_pct_cap = excluded.daily_usage_pct_cap,
  overage_writes_per_1k_inr = excluded.overage_writes_per_1k_inr,
  overage_reads_per_1k_inr = excluded.overage_reads_per_1k_inr,
  overage_embed_tokens_per_1m_inr = excluded.overage_embed_tokens_per_1m_inr,
  overage_gen_tokens_per_1m_inr = excluded.overage_gen_tokens_per_1m_inr,
  overage_storage_gb_month_inr = excluded.overage_storage_gb_month_inr,
  is_active = excluded.is_active,
  metadata = excluded.metadata,
  updated_at = now();

create or replace view workspace_entitlements_v3 as
select
  e.id,
  e.workspace_id,
  p.plan_code,
  p.display_name as plan_label,
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

alter table if exists plans enable row level security;
alter table if exists entitlements enable row level security;

drop policy if exists plans_select on plans;
drop policy if exists plans_modify on plans;
drop policy if exists entitlements_select on entitlements;
drop policy if exists entitlements_modify on entitlements;

create policy plans_select on plans
  for select using (true);

create policy plans_modify on plans
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy entitlements_select on entitlements
  for select using (
    auth.role() = 'service_role'
    or exists (
      select 1 from workspace_members m
      where m.workspace_id = entitlements.workspace_id and m.user_id = auth.uid()
    )
  );

create policy entitlements_modify on entitlements
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

revoke all on table plans from public;
revoke all on table entitlements from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on table plans to authenticated';
    execute 'grant select on table entitlements to authenticated';
    execute 'grant select on table workspace_entitlements_v3 to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table plans to service_role';
    execute 'grant all on table entitlements to service_role';
    execute 'grant select on table workspace_entitlements_v3 to service_role';
    execute 'grant usage, select on sequence plans_id_seq to service_role';
    execute 'grant usage, select on sequence entitlements_id_seq to service_role';
  end if;
end $$;
