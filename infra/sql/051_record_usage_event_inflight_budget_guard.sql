-- 051_record_usage_event_inflight_budget_guard.sql
-- Add in-flight reservation pressure to budget hard-cap checks and
-- serialize same-workspace/day cap checks to reduce race-condition overspend.

set search_path = public;

do $$
declare
  fn_sql text;
  fn_sig regprocedure := 'public.record_usage_event_if_within_cap(uuid,date,text,text,text,text,text,integer,integer,integer,bigint,integer,bigint,bigint,bigint,numeric,boolean,jsonb,bigint,bigint,bigint,bigint,bigint,bigint,bigint)'::regprocedure;
begin
  select pg_get_functiondef(fn_sig) into fn_sql;

  if fn_sql is null then
    raise exception 'record_usage_event_if_within_cap not found';
  end if;

  if position('v_reserved_inflight numeric(12,6) := 0;' in fn_sql) = 0 then
    fn_sql := replace(
      fn_sql,
      '  v_budget_used numeric(12,6) := 0;',
      E'  v_budget_used numeric(12,6) := 0;\n  v_reserved_inflight numeric(12,6) := 0;'
    );
  end if;

  if position('pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || '':'' || v_day::text, 0));' in fn_sql) = 0 then
    fn_sql := replace(
      fn_sql,
      '  v_day := coalesce(p_day, (now() at time zone ''utc'')::date);',
      E'  v_day := coalesce(p_day, (now() at time zone ''utc'')::date);\n  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || '':'' || v_day::text, 0));'
    );
  end if;

  if position('v_reserved_inflight' in fn_sql) > 0
     and position('from usage_reservations r' in fn_sql) = 0
     and position('if v_hard_cap_enabled and v_budget_cap is not null then' in fn_sql) > 0 then
    fn_sql := replace(
      fn_sql,
      E'  if v_hard_cap_enabled and v_budget_cap is not null then\n',
      E'  if v_hard_cap_enabled and v_budget_cap is not null then\n' ||
      E'    select coalesce(sum(r.estimated_cost_inr), 0)\n' ||
      E'      into v_reserved_inflight\n' ||
      E'    from usage_reservations r\n' ||
      E'    where r.workspace_id = p_workspace_id\n' ||
      E'      and r.status = ''reserved''\n' ||
      E'      and coalesce(r.expires_at, r.created_at + interval ''30 minutes'') > now()\n' ||
      E'      and (r.request_id is null or not exists (\n' ||
      E'        select 1\n' ||
      E'        from usage_events ue2\n' ||
      E'        where ue2.workspace_id = p_workspace_id\n' ||
      E'          and ue2.request_id = r.request_id\n' ||
      E'          and ue2.event_ts >= v_period_start\n' ||
      E'          and ue2.event_ts < v_period_end\n' ||
      E'      ));\n\n'
    );
  end if;

  if position('(v_budget_used + p_estimated_cost_inr) > v_budget_cap' in fn_sql) > 0 then
    fn_sql := replace(
      fn_sql,
      '(v_budget_used + p_estimated_cost_inr) > v_budget_cap',
      '(v_budget_used + v_reserved_inflight + p_estimated_cost_inr) > v_budget_cap'
    );
  end if;

  execute fn_sql;
end
$$;
