# Release Gate

Canonical release process:
- `docs/RELEASE_RUNBOOK.md`

Gate command:

```bash
pnpm release:gate
```

`release:gate` runs:
1) `pnpm check:typed-entry`
2) `pnpm check:wrangler`
3) `pnpm check:config`
4) `pnpm secrets:check`
5) `pnpm secrets:check:tracked`
6) `pnpm migrations:check`
7) `pnpm -w lint`
8) `pnpm -w typecheck`
9) `pnpm -w test`

Optional build:

```bash
RELEASE_INCLUDE_BUILD=1 pnpm release:gate
```

DB-inclusive gate:

```bash
pnpm release:gate:full
```
