-- 014_activation.sql - activation/funnel aggregates with RLS

-- Harden product_events with RLS (membership or service role)
do $$
declare
  pol record;
begin
  for pol in select policyname from pg_policies where tablename = 'product_events' loop
    execute format('drop policy if exists %I on product_events', pol.policyname);
  end loop;

  alter table if exists product_events enable row level security;

  create policy product_events_select on product_events
    for select using (
      auth.role() = 'service_role'
      or exists (
        select 1 from workspace_members m
        where m.workspace_id = product_events.workspace_id and m.user_id = auth.uid()
      )
    );

  create policy product_events_insert on product_events
    for insert with check (auth.role() = 'service_role');

  create policy product_events_update on product_events
    for update using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

  create policy product_events_delete on product_events
    for delete using (auth.role() = 'service_role');
end $$;

-- Workspace-scoped activation counts over a rolling win
create or replace function activation_counts(p_workspace_id uuid, p_days integer default 1)
returns table(event_name text, count bigint)
language sql
stable
as $$
  with win as (
    select greatest(1, least(coalesce(p_days, 1), 30)) as days
  )
  select event_name, count(*)::bigint
  from product_events, win
  where workspace_id = p_workspace_id
    and created_at >= now() - make_interval(days => win.days)
    and event_name in (
      'api_key_created',
      'first_ingest_success',
      'first_search_success',
      'first_context_success',
      'cap_exceeded',
      'checkout_started',
      'upgrade_activated'
    )
  group by event_name;
$$;
