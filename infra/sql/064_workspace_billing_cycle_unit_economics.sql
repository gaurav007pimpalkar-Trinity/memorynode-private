-- 064_workspace_billing_cycle_unit_economics.sql
-- Per-workspace revenue (current entitlement period) vs estimated infra-style cost
-- from gen/embed token unit rates and storage GB.

set search_path = public;

create or replace function list_workspace_billing_cycle_unit_economics(
  p_gen_cost_inr_per_token numeric default 0,
  p_embed_cost_inr_per_token numeric default 0,
  p_storage_cost_inr_per_gb numeric default 0
)
returns table (
  workspace_id uuid,
  workspace_name text,
  entitlement_id bigint,
  plan_code text,
  period_start timestamptz,
  period_end timestamptz,
  embed_tokens_used bigint,
  gen_tokens_used bigint,
  storage_gb_used numeric,
  revenue_inr numeric,
  estimated_cost_inr numeric,
  cost_pct_of_revenue numeric,
  cost_over_half_revenue boolean,
  cost_exceeds_revenue boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select
      e.workspace_id,
      w.name as workspace_name,
      e.id as ent_id,
      p.plan_code as p_code,
      e.period_start as p_start,
      e.period_end as p_end,
      coalesce(u.embed_tokens, 0)::bigint as emb,
      coalesce(u.gen_tokens, 0)::bigint as gen,
      greatest(coalesce(u.storage_bytes, 0)::numeric / 1000000000.0, 0) as gb,
      round(
        (
          p.price_inr::numeric
          + case
            when coalesce(u.writes, 0) > p.included_writes
            then (coalesce(u.writes, 0) - p.included_writes)::numeric * (p.overage_writes_per_1k_inr / 1000.0)
            else 0::numeric
          end
          + case
            when coalesce(u.reads, 0) > p.included_reads
            then (coalesce(u.reads, 0) - p.included_reads)::numeric * (p.overage_reads_per_1k_inr / 1000.0)
            else 0::numeric
          end
          + case
            when coalesce(u.embed_tokens, 0) > p.included_embed_tokens
            then (coalesce(u.embed_tokens, 0) - p.included_embed_tokens)::numeric * (p.overage_embed_tokens_per_1m_inr / 1000000.0)
            else 0::numeric
          end
          + case
            when coalesce(u.gen_tokens, 0) > p.included_gen_tokens
            then (coalesce(u.gen_tokens, 0) - p.included_gen_tokens)::numeric * (p.overage_gen_tokens_per_1m_inr / 1000000.0)
            else 0::numeric
          end
          + case
            when (coalesce(u.storage_bytes, 0)::numeric / 1000000000.0) > p.included_storage_gb
            then
              ((coalesce(u.storage_bytes, 0)::numeric / 1000000000.0) - p.included_storage_gb)
              * p.overage_storage_gb_month_inr
            else 0::numeric
          end
        )::numeric,
        2
      ) as rev,
      round(
        (
          coalesce(u.gen_tokens, 0)::numeric * coalesce(p_gen_cost_inr_per_token, 0)
          + coalesce(u.embed_tokens, 0)::numeric * coalesce(p_embed_cost_inr_per_token, 0)
          + greatest(coalesce(u.storage_bytes, 0)::numeric / 1000000000.0, 0) * coalesce(p_storage_cost_inr_per_gb, 0)
        )::numeric,
        6
      ) as ecost
    from entitlements e
    join plans p on p.id = e.plan_id
    join workspaces w on w.id = e.workspace_id
    join lateral compute_period_usage(e.workspace_id, e.period_start, e.period_end, e.id) u on true
    where e.status in ('active', 'grace')
      and e.period_start <= now()
      and e.period_end > now()
  )
  select
    base.workspace_id,
    base.workspace_name,
    base.ent_id,
    base.p_code,
    base.p_start,
    base.p_end,
    base.emb,
    base.gen,
    base.gb,
    base.rev,
    base.ecost,
    case
      when base.rev > 0 then round((base.ecost / base.rev * 100)::numeric, 4)
      else null::numeric
    end as cost_pct_of_revenue,
    (base.ecost > base.rev * 0.5) as cost_over_half_revenue,
    (base.ecost > base.rev) as cost_exceeds_revenue
  from base;
$$;

revoke all on function list_workspace_billing_cycle_unit_economics(numeric, numeric, numeric) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function list_workspace_billing_cycle_unit_economics(numeric, numeric, numeric) to service_role';
  end if;
end $$;
