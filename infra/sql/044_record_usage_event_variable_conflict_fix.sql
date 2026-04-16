-- 044_record_usage_event_variable_conflict_fix.sql
-- Ensures PL/pgSQL resolves table columns over OUT parameters in
-- record_usage_event_if_within_cap to avoid ambiguous references.

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
    'on conflict (workspace_id, idempotency_key) do nothing',
    'on conflict on constraint usage_events_workspace_idempotency_uniq do nothing'
  );

  execute fn_sql;
end
$$;
