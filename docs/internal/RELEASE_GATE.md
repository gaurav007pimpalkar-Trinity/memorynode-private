## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# Release Gate

Canonical release process:
- `docs/internal/RELEASE_RUNBOOK.md`

Gate command:

```bash
pnpm release:gate
```

`release:gate` runs:
1) `pnpm check:typed-entry`
2) `pnpm check:wrangler`
3) `pnpm check:config`
4) `pnpm check:economics-gate` (fails when worst-case plan cost breaches fixed INR or margin threshold)
5) `pnpm secrets:check`
6) `pnpm secrets:check:tracked`
7) `pnpm migrations:check`
8) `pnpm -w lint`
9) `pnpm -w typecheck`
10) `pnpm -w test`

Optional build:

```bash
RELEASE_INCLUDE_BUILD=1 pnpm release:gate
```

Economics thresholds source:

- `scripts/economics_thresholds.json`
- Evaluated by `pnpm check:economics-gate` using plan limits in `packages/shared/src/plans.ts`
- Cost is computed via shared runtime model in `packages/shared/src/costModel.ts` (same estimator used by API reservation path)

DB-inclusive gate:

```bash
pnpm release:gate:full
```
