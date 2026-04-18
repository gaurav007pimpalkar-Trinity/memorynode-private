# @memorynodeai/cli (`mn`)

Small CLI for local checks and copy-paste quickstart.

## Usage (from repo root)

```bash
pnpm mn doctor      # validate apps/api/.dev.vars for local API
pnpm mn quickstart  # print hosted curl quickstart
```

Or after `pnpm install` globally from this package: `pnpm exec mn doctor`.

## Commands

- **`doctor`** — runs `scripts/preflight_dev_env.mjs`. If `API_KEY` and `BASE_URL` are set (and no monorepo), probes `GET /v1/usage/today`.
- **`quickstart`** — prints the three core `curl` commands (memories, search, context).
