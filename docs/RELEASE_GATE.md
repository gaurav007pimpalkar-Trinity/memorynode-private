# Release Gate (GA / Prod Readiness)

## Command
```
CHECK_ENV=production pnpm release:gate
```
`release:gate` (code/config only) runs, in order:
1) check:typed-entry  
2) check:wrangler  
3) check:config (with CHECK_ENV=production)  
4) lint  
5) typecheck  
6) test:ci (includes vitest suite)  

`release:gate:full` adds database safety:
- Runs `release:gate`, then `pnpm db:check` (migrate + verify RLS) against SUPABASE_DB_URL/DATABASE_URL.

## Required environment
- `CHECK_ENV=production` (set by the script)
- `SUPABASE_DB_URL` or `DATABASE_URL` (only required for `release:gate:full`; not needed for `release:gate`)
- Cloudflare/OpenAI/Stripe secrets are not printed, but the checks require them to be set in your env or platform.
- If running on Windows, `cross-env` is bundled to set CHECK_ENV safely.

Expected failure if DB URL missing (only for `release:gate:full`):
```
> pnpm release:gate:full
Missing SUPABASE_DB_URL (or DATABASE_URL) environment variable.
```
Set the URL then rerun.

## CI/CD usage
- Run in staging first; promote the same artifact to production after a green gate.
- Pair with staging smoke: `pnpm stripe:smoke` and `pnpm stripe:webhook-test` (set BASE_URL/STRIPE_WEBHOOK_SECRET/MEMORYNODE_API_KEY).

## Related docs
- Observability: OBSERVABILITY.md
- Backups & restores: BACKUP_RESTORE.md
- Performance baseline: PERFORMANCE.md
- Dashboard manual checks: DASHBOARD_TEST_CHECKLIST.md

## Notes
- k6 perf (`pnpm perf:k6`) is optional / off the gate by default.
- Ensure wrangler.toml bindings (RATE_LIMIT_DO) and migrations are present before running in prod.
