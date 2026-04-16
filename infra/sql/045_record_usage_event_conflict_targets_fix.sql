-- 045_record_usage_event_conflict_targets_fix.sql
-- Restores valid ON CONFLICT targets and keeps variable conflict resolution
-- to avoid ambiguity between OUT parameters and table columns.

do $$
declare
  fn_sql text;
begin
  select pg_get_functiondef(
    'public.record_usage_event_if_within_cap(uuid,date,text,text,text,text,text,integer,integer,integer,bigint,integer,bigint,bigint,bigint,numeric,boolean,jsonb,bigint,bigint,bigint,bigint,bigint,bigint,bigint)'::regprocedure
  )
  into fn_sql;

  if fn_sql is null then
    raise exception 'record_usage_event_if_within_cap not found';
  end if;

  if position('#variable_conflict use_column' in fn_sql) = 0 then
    fn_sql := replace(
      fn_sql,
      E'\ndeclare\n',
      E'\n#variable_conflict use_column\ndeclare\n'
    );
  end if;

  fn_sql := replace(
    fn_sql,
    'on conflict on constraint usage_events_workspace_idempotency_uniq do nothing',
    'on conflict (workspace_id, idempotency_key) do nothing'
  );
  fn_sql := replace(
    fn_sql,
    'on conflict on constraint usage_alert_events_dedupe_key do nothing;',
    'on conflict (workspace_id, entitlement_id, day, threshold_pct, metric) do nothing;'
  );

  execute fn_sql;
end
$$;
