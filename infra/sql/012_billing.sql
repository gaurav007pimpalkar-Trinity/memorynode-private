-- Billing foundation
alter table workspaces
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_price_id text,
  add column if not exists plan_status text not null default 'free',
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_plan_status_check') then
    alter table workspaces add constraint workspaces_plan_status_check
      check (plan_status in ('free','trialing','active','past_due','canceled'));
  end if;
end$$;

create index if not exists workspaces_stripe_customer_id_idx on workspaces (stripe_customer_id);
create index if not exists workspaces_stripe_subscription_id_idx on workspaces (stripe_subscription_id);
create index if not exists workspaces_stripe_price_id_idx on workspaces (stripe_price_id);
