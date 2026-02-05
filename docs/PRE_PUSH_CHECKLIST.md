# Pre-Push Checklist (local-friendly)

Run this before committing/pushing to ensure the repo is clean and testable without production secrets:

```
pnpm push:gate
```

`push:gate` runs: `scan:secrets` → `lint` → `typecheck` → `test:ci`. It does **not** require production env vars or database access.

For production readiness, use `pnpm release:gate` (or `release:gate:full`) — those will fail locally unless you supply the required prod env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY_SALT, MASTER_ADMIN_TOKEN, EMBEDDINGS_MODE, STRIPE secrets, etc.).
