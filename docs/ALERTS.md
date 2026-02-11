# MemoryNode Alerts

Minimal, launch-safe monitoring and alert thresholds using existing structured logs.

## 1) Metrics To Watch

| Signal | Source fields | Why it matters |
| --- | --- | --- |
| 5xx rate | `event_name="request_completed"`, `status>=500` | direct customer impact |
| Auth failure rate | `request_completed` with `status=401 or 403` | key/token breakage or abuse |
| p95 latency | `request_completed.duration_ms` | user experience degradation |
| Rate-limit denials | `request_completed.error_code="rate_limited"` + `event_name="cap_exceeded"` | abuse, mis-sized quotas, user friction |
| Stripe webhook failures | `event_name in ("webhook_failed","billing_webhook_signature_invalid","billing_endpoint_error","billing_webhook_workspace_not_found")` | billing reliability risk |
| Supabase/RPC error rate | `request_completed.error_code="DB_ERROR"` | data-path reliability risk |

## 2) Early-Stage Thresholds (Suggested)

Use low-volume-friendly thresholds (count + rate).

| Alert | Warn | Critical |
| --- | --- | --- |
| 5xx rate | >1% over 5 min and >=5 events | >3% over 5 min or >=20 events |
| Auth failure rate (401/403) | >20% over 10 min and >=30 requests | >40% over 10 min and >=50 requests |
| p95 latency | >1200 ms over 10 min | >2500 ms over 10 min |
| Rate-limit denials | >=50 in 5 min | >=150 in 5 min |
| Stripe webhook failures | >=5 in 10 min | >=20 in 10 min |
| DB/RPC errors | >=5 in 10 min | >=20 in 10 min |

## 3) Cloudflare Setup (Manual)

1. Open Cloudflare dashboard -> Workers & Pages -> API Worker -> Logs.
2. Create saved log views for:
   - `event_name="request_completed"`
   - `event_name="request_completed" AND status>=500`
   - `event_name="request_completed" AND (status=401 OR status=403)`
   - `event_name in ("webhook_failed","billing_webhook_signature_invalid")`
   - `event_name="request_completed" AND error_code="DB_ERROR"`
3. Configure notifications (email/Slack/webhook) from your log/alerting destination.
4. Route alerts to on-call with two severities:
   - warning (triage during business hours)
   - critical (page immediately)

If native log alerting is not yet configured, run a lightweight scheduled check that queries logs and posts to on-call channels.

## 4) Triage Mapping

| Alert | First action |
| --- | --- |
| 5xx spike | Check latest deploy, inspect `error_code`, run `TARGET_ENV=staging STAGING_BASE_URL=... API_KEY=... pnpm release:staging:validate` against affected env |
| Auth failure spike | Validate `MASTER_ADMIN_TOKEN` and API key/salt state; verify with `TARGET_ENV=staging STAGING_BASE_URL=... ADMIN_TOKEN=... pnpm release:staging:validate` |
| Latency spike | Inspect route-level distribution (`route`, `method`), check Supabase and external dependencies |
| Rate-limit spike | Investigate abuse patterns, confirm `RATE_LIMIT_DO` health, tune limits if needed |
| Stripe failures | Verify webhook secret + endpoint, replay events after fix |
| DB error spike | Validate Supabase status/credentials, run RLS/migration checks (`pnpm db:verify-rls`, `pnpm db:drift:test`) |

## 5) Related Runbooks

- Launch procedure: `docs/LAUNCH_RUNBOOK.md`
- Ops secrets + rollback notes: `docs/OPERATIONS.md`
- Backup/restore: `docs/BACKUP_RESTORE.md`
