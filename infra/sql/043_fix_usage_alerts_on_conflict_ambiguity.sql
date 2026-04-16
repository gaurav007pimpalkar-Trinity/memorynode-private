-- 043_fix_usage_alerts_on_conflict_ambiguity.sql
-- Fixes PL/pgSQL ambiguity in record_usage_event_if_within_cap where OUT column
-- names (workspace_id, entitlement_id, day) can conflict with ON CONFLICT column
-- references during usage_alert_events inserts.

do $$
declare
  fn_sql text;
  needle text := 'on conflict (workspace_id, entitlement_id, day, threshold_pct, metric) do nothing;';
  replacement text := 'on conflict on constraint usage_alert_events_dedupe_key do nothing;';
begin
  select pg_get_functiondef(
    'public.record_usage_event_if_within_cap(uuid,date,text,text,text,text,text,integer,integer,integer,bigint,integer,bigint,bigint,bigint,numeric,boolean,jsonb,bigint,bigint,bigint,bigint,bigint,bigint,bigint)'::regprocedure
  )
  into fn_sql;

  if fn_sql is null then
    raise exception 'record_usage_event_if_within_cap not found';
  end if;

  if position(needle in fn_sql) = 0 then
    -- If not present, function might already be patched; keep migration idempotent.
    raise notice 'record_usage_event_if_within_cap already patched for usage_alert_events conflict target';
    return;
  end if;

  fn_sql := replace(fn_sql, needle, replacement);
  execute fn_sql;
end
$$;
