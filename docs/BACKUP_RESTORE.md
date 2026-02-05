# Backup & Restore Runbook (Supabase/Postgres)

## Objectives
- **RPO (Recovery Point Objective)**: target ≤ 15 minutes of data loss (adjust per risk appetite).
- **RTO (Recovery Time Objective)**: target ≤ 60 minutes to full API recovery (DB restored + smoke tests green).

## What must be backed up
- Postgres database (schema + data) — source of truth for MemoryNode.
- Storage buckets: _none currently used_ (update if added).
- Idempotency table: `stripe_webhook_events` (important to keep to avoid double-processing on replay).
- Secrets/config: stored via Cloudflare `wrangler secret` and CI/CD secrets; back up references/last-rotated dates (never values).

## Backup options
### 1) Supabase managed backups
- Enable automated backups in the Supabase project.
- Verification: on a schedule, clone/restore to a throwaway project and run the restore drill (see below).

### 2) Logical backups via `pg_dump`
Use a service role connection string with read access:
```
export PGURL="$SUPABASE_DB_URL"
pg_dump --format=custom --verbose --file=backup_$(date +%Y%m%d%H%M).dump "$PGURL"
```
To include only schema:
```
pg_dump --schema-only --file=schema_$(date +%Y%m%d%H%M).sql "$PGURL"
```

### 3) Point-in-time recovery (PITR)
- Use if your Supabase plan supports PITR. Ensure WAL archiving is enabled and retention meets the RPO.
- Periodically test by restoring to a timestamp in a new project.

## Restore procedure (drill and real)
1) **Restore target**: create a NEW Supabase project (staging). Do not restore directly into prod.
2) **Load backup**:
   - For pg_dump: `pg_restore --verbose --clean --no-owner --dbname="$RESTORE_DB_URL" backup_YYYYMMDDHHMM.dump`
   - For schema-only backup: `psql "$RESTORE_DB_URL" -f schema_YYYYMMDDHHMM.sql`
3) **Apply migrations if needed**:
   - `SUPABASE_DB_URL="$RESTORE_DB_URL" pnpm db:migrate`
4) **Verify RLS and policies**:
   - `SUPABASE_DB_URL="$RESTORE_DB_URL" pnpm db:verify-rls`
5) **Smoke tests (API)**: point API at the restored DB (env override) and run:
   - `pnpm test:ci` (or a targeted subset)
   - Stripe webhook idempotency sanity: `BASE_URL=<stage-api> STRIPE_WEBHOOK_SECRET=... pnpm stripe:webhook-test`
6) **Promote**: only after staging restore passes, promote/replace prod DB or re-point the API.

## Restore drill checklist (measure RTO)
- [ ] Record start time (T0).
- [ ] New staging project created.
- [ ] Backup restore finished (pg_restore or Supabase clone).
- [ ] Migrations applied (`pnpm db:migrate`).
- [ ] RLS verified (`pnpm db:verify-rls`).
- [ ] API smoke tests (minimal) passed.
- [ ] Stripe webhook replay test passed.
- [ ] Record end time (T_end) and compute RTO = T_end - T0.
- [ ] Log issues and fixes; update runbook as needed.

## Failure modes & mitigations
- **Schema drift / checksum mismatch in migrations**: rerun with clean restore; reconcile drift before promote.
- **Missing RLS/policies**: rerun migrations; verify with `pnpm db:verify-rls`.
- **Partial restore / missing data**: confirm backup recency vs RPO; if gap exceeds RPO, consider PITR to closer timestamp.
- **Webhook idempotency table missing**: re-run migrations; if data lost, expect Stripe to retry events—monitor for duplicates.
- **Secrets missing**: re-seed Cloudflare `wrangler secret` and CI/CD secrets; never commit values.

## Notes
- Keep backups encrypted at rest. Restrict who can access PGURL and dump files.
- Rotate service-role keys used for backups and audit access.
