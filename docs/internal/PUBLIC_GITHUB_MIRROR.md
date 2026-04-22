## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# Public GitHub mirror (`memorynode` vs `memorynode-private`)

## Two repositories

| Remote (in this clone) | GitHub repo | Role |
| ---------------------- | ----------- | ---- |
| `origin` | `memorynode-private` | **Full monorepo** — API, dashboard, infra, internal docs, CI, secrets templates. All day-to-day work happens here. |
| `memorynode-public` | [`memorynode`](https://github.com/gaurav007pimpalkar-Trinity/memorynode) | **Curated public surface** — quickstart, `index.mjs`, and a small set of customer-facing docs only. No Worker source, no migrations, no runbooks. |

## What gets published

The list is **manifest-driven**: [scripts/public_github_mirror.json](../../scripts/public_github_mirror.json).

Today it includes:

- `public-onboarding/` runnable quickstart (`package.json`, `index.mjs`, `.gitignore`, `LICENSE`)
- Root **`README.md`** for the public repo from [`public-onboarding/README_PUBLIC_REPO.md`](../../public-onboarding/README_PUBLIC_REPO.md) (standalone links only — no `../docs/...` into the private tree)
- Selected trust / product docs under **`docs/`** on the public repo, copied from `docs/external/` and `docs/` with link rewrites applied by the sync script

**Never** add internal paths to the manifest (`docs/internal/`, `apps/api/`, `infra/sql/`, deploy scripts, etc.).

## How to sync (operators)

1. Commit and push your changes to **`origin`** (`memorynode-private`) as usual.
2. Update [`public-onboarding/README_PUBLIC_REPO.md`](../../public-onboarding/README_PUBLIC_REPO.md) or manifest entries if public copy should change.
3. From the **private repo root**:

   ```bash
   pnpm sync:public-github
   ```

   This reclones the public repo into **`.public-github-sync/`** (gitignored), applies the manifest, and prints `git status`. Inspect the tree.

4. To create a commit inside the staging clone (still no push):

   ```bash
   pnpm sync:public-github:commit
   ```

5. To **push** to `main` on the public repo:

   ```bash
   set PUBLIC_SYNC_CONFIRM=1
   pnpm sync:public-github:push
   ```

   On macOS/Linux:

   ```bash
   PUBLIC_SYNC_CONFIRM=1 pnpm sync:public-github:push
   ```

   Requires `git` credentials that can push to `https://github.com/gaurav007pimpalkar-Trinity/memorynode.git` (HTTPS token or SSH remote — if you use SSH, set `memorynode-public` to the SSH URL).

## Adding a new public doc

1. Confirm the file is **safe for the internet** (no internal URLs, no incident detail, no unreleased roadmap).
2. If it links to other monorepo-only paths, either add those targets to the manifest **or** replace links with absolute URLs (console, npm, your marketing site) in a **public-specific** copy under `public-onboarding/` instead of mirroring raw private files.
3. Add a `{ "from": "...", "to": "docs/....md", "transform": "publicDocs" }` entry if the sync script’s **`publicDocs`** transform should strip the supporting header and rewrite known broken relatives. Extend [`scripts/sync_public_github_repo.mjs`](../../scripts/sync_public_github_repo.mjs) if new rewrite rules are needed.

## Related

- [PUBLIC_ONBOARDING_REPO.md](./PUBLIC_ONBOARDING_REPO.md) — original scope of `public-onboarding/`
- Monorepo **developer** README: [../../README.md](../../README.md)
