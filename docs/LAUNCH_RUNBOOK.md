# Launch Runbook (Pointer)

Canonical release instructions now live in:
- `docs/RELEASE_RUNBOOK.md`

Use this file only as a pointer to avoid command drift.

## Launch-day Operator Flow
- Run the pre-release gate:
  - `pnpm release:gate`
- Follow staging deploy + validate steps in `docs/RELEASE_RUNBOOK.md`.
- Follow canary/prod deploy + validate steps in `docs/RELEASE_RUNBOOK.md`.
- If needed, execute rollback and kill-switch steps from `docs/RELEASE_RUNBOOK.md`.

## Related Docs
- `docs/PROD_READY.md`
- `docs/OBSERVABILITY.md`
- `docs/OPERATIONS.md`
- `docs/BILLING_RUNBOOK.md`
