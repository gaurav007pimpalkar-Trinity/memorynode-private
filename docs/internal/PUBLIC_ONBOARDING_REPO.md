## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# Public Onboarding Repository

## Purpose

The **public onboarding repository** is a minimal, production-quality GitHub repo that will be pushed as a **standalone public repository**. It is for developer onboarding and trust only. It contains no internal source code, infrastructure, scripts, or runbooks.

## Contents of `public-onboarding/`

This folder is the exact content that will become the public repo. It contains **only**:

| File | Purpose |
|------|--------|
| `README.md` | Onboarding when you are **inside the monorepo** — links to `../README.md` and `../docs/...` |
| `README_PUBLIC_REPO.md` | **Standalone** intro for the [public GitHub mirror](PUBLIC_GITHUB_MIRROR.md) only (no `../` links to private paths). Synced as `README.md` on [memorynode](https://github.com/gaurav007pimpalkar-Trinity/memorynode). |
| `package.json` | `memorynode-quickstart`, dependency on `@memorynodeai/sdk`, `start` script |
| `index.mjs` | Runnable quickstart: add memory, search, log results; uses `API_KEY` and optional `BASE_URL` |
| `.gitignore` | `node_modules/`, `.env`, `.env.*`, `*.log` |

No other files belong in the public repo. Do **not** add API source, Worker code, dashboard, infra, internal docs, or runbooks.

## Sync process when SDK versions change

1. **Publish the new SDK version to npm**  
   From the private repo: publish `@memorynodeai/shared` (if needed) and `@memorynodeai/sdk` with the new version.

2. **Update the dependency in this repo**  
   Edit `public-onboarding/package.json` and set the `@memorynodeai/sdk` version (e.g. `"^0.2.0"`).

3. **Push the updated content to the public GitHub repo**  
   Use the manifest-driven sync (recommended): [PUBLIC_GITHUB_MIRROR.md](./PUBLIC_GITHUB_MIRROR.md) — `pnpm sync:public-github` then `pnpm sync:public-github:push` with `PUBLIC_SYNC_CONFIRM=1`. Alternatively, manually copy only the manifest-listed files into [memorynode](https://github.com/gaurav007pimpalkar-Trinity/memorynode).

## What must never be included

- API or Worker source code  
- Dashboard or internal app code  
- Infrastructure config (e.g. wrangler, Cloudflare, Supabase)  
- Scripts or runbooks (deploy, release, billing, migrations, etc.)  
- Internal documentation (runbooks, checklists, operational guides)  
- Secrets, keys, or environment-specific configuration  
