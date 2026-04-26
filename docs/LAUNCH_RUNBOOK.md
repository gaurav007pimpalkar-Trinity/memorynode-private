# Launch Runbook (Lean)

This runbook is intentionally short: deploy safely, verify critical paths, and know what to check first if something breaks.

## 1) Before Deploy

Set required environment values for target deploy:

- `CHECK_ENV=staging` or `CHECK_ENV=production`
- API/runtime env vars needed by `pnpm check:config`
- Dashboard build env vars (optional; defaults are injected by `prod:check`):
  - `VITE_API_BASE_URL`
  - `VITE_APP_SURFACE`
  - `VITE_BUILD_SHA`

Run preflight:

```bash
pnpm prod:check
```

What `prod:check` runs (fail-fast):

1. typecheck
2. tests
3. critical flow checks
4. config validation
5. observability contract check
6. API build
7. dashboard build

## 2) Deploy

### Staging

```bash
pnpm deploy:staging
```

### Production

```bash
pnpm deploy:prod
```

Both commands run preflight first, then call the existing hardened deploy scripts.

## 3) Post-Deploy Verification

### Fast checks

1. Health endpoint:
   - `GET /healthz` returns `status: "ok"`
2. Release validation:
   - `pnpm release:validate` (or env-specific `release:staging:validate` / `release:prod:validate`)
3. Critical flow checks (local/CI-level):
   - `pnpm critical:flows:check`

### Product checks (manual)

1. New user signup and first workspace bootstrap
2. Existing user login
3. Billing flow callback returns to billing screen
4. Memory create + search basic usage

## 4) If Something Breaks

Start with these in order:

1. Re-run preflight:
   - `pnpm prod:check`
2. Validate config:
   - `pnpm check:config`
3. Validate deployment:
   - `pnpm release:validate`
4. Check health/build version:
   - `GET /healthz`
5. Re-run flow checks:
   - `pnpm critical:flows:check`

If deploy fails, the deploy scripts already print the failing step and required env hints. Fix that first, then retry.
