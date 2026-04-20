# Frontend deployment (console + founder app)

One codebase: `apps/dashboard`. Two production sites:

| Cloudflare Pages project | Domain | Build-time surface |
|----------------------------|--------|---------------------|
| `memorynode-console` | `https://console.memorynode.ai` | `VITE_APP_SURFACE=console` |
| `memorynode-app` | `https://app.memorynode.ai` (founder UI at `/founder`) | `VITE_APP_SURFACE=app` |

Both must use the same **API** in production: `VITE_API_BASE_URL=https://api.memorynode.ai`.

---

## Reliable deploy (recommended)

Use a **single** command so both surfaces are built from the same checkout, then both uploads run in order.

From the **repository root** (after `pnpm install`):

```bash
export VITE_API_BASE_URL=https://api.memorynode.ai
export VITE_CONSOLE_BASE_URL=https://console.memorynode.ai
export VITE_SUPABASE_URL=...        # required for the console bundle (Supabase Auth)
export VITE_SUPABASE_ANON_KEY=...   # anon key only
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
pnpm dashboard:deploy:pages
```

What this does:

1. Resolves **`VITE_BUILD_SHA`** once (`VITE_BUILD_SHA` env → `GITHUB_SHA` → `git rev-parse HEAD`) and logs it. Both bundles embed the same value in **`/version.json`** (`gitSha`, `surface`, `builtAt`).
2. Builds `apps/dashboard/dist-console` with `VITE_APP_SURFACE=console`, then `dist-app` with `VITE_APP_SURFACE=app`. Fails before upload if the two local `version.json` files disagree with each other or with `VITE_BUILD_SHA`.
3. If either build fails, **nothing** is deployed from this run.
4. Uploads `memorynode-console`, then `memorynode-app`. If that round fails, **both** projects are uploaded again once (transient Wrangler / network errors).
5. Runs **`pnpm dashboard:verify:pages`** (HTTP 200 on console home and `/founder` on app, then both `/version.json` must match and equal `VITE_BUILD_SHA`). Retries with delay for CDN propagation. If verify fails, **both** projects are re-uploaded once, then verify runs again.
6. If anything still fails, the process exits with **code 1** and prints the exact `VITE_BUILD_SHA=...` command to re-run — the job is **not** treated as successful.

**Partial deploy caveat:** Cloudflare still cannot atomically publish two Pages projects. Recovery is: same checkout, re-run `pnpm dashboard:deploy:pages` (or the GitHub workflow) using the printed SHA so console and app converge again.

**Verify only (e.g. after a manual Pages upload):**

```bash
export VITE_BUILD_SHA=<full-sha-you-expect-live>
pnpm dashboard:verify:pages
# optional: --console-origin https://... --app-origin https://... --attempts 12
```

Equivalent from `apps/dashboard`:

```bash
pnpm run deploy:pages
```

(same env vars; still uses root scripts under the hood).

---

## GitHub Actions (same commit, both projects)

Workflow: `.github/workflows/dashboard-pages-deploy.yml`

After checkout, the workflow sets **`VITE_BUILD_SHA`** from `git rev-parse HEAD` so the built `version.json` always matches the tree you checked out (including when you pass a custom **ref** on `workflow_dispatch`).

1. Repo → **Settings → Environments → production** (or your chosen environment).
2. Add secrets used by the workflow:

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | Pages deploy (same as API deploy if you reuse it) |
| `CLOUDFLARE_ACCOUNT_ID` | Account id for wrangler |
| `DASHBOARD_VITE_SUPABASE_URL` | Mapped to `VITE_SUPABASE_URL` for the **console** build |
| `DASHBOARD_VITE_SUPABASE_ANON_KEY` | Mapped to `VITE_SUPABASE_ANON_KEY` for the **console** build |

3. **Actions → Dashboard Pages Deploy → Run workflow**. Optional **ref** = branch, tag, or full SHA (defaults to the commit SHA of the run).

The job sets `VITE_API_BASE_URL` and `VITE_CONSOLE_BASE_URL` to production values; you do not put the API URL in secrets unless you prefer to.

**Keeping frontend in step with the API:** deploy the API for that commit first (or your usual release order), then run this workflow for the **same SHA**.

---

## Cloudflare Pages (Git-connected) — two projects

If you use “Connect to Git” **twice** (one project per domain), each project must set **different** production env vars (`VITE_APP_SURFACE` is `console` vs `app`). That can drift if only one branch build runs. Prefer **Direct upload** or **GitHub Actions** above so both builds are defined in repo scripts.

If you stay on Git-connected builds:

- **Root directory:** repo root (empty).
- **Build command:** not the shared default alone — you need **per-project** commands. Cloudflare Pages does not run the dual-build script automatically unless you set the build command to something that builds **only** the matching surface. Safer pattern: disable auto-build on one project and always deploy both via `pnpm dashboard:deploy:pages` from CI.

---

## Environment variables (production)

**Shared**

- `VITE_API_BASE_URL` — `https://api.memorynode.ai` (required; Vite **fails the build** if missing or localhost in production mode).
- `VITE_CONSOLE_BASE_URL` — `https://console.memorynode.ai` (link from founder app).

**Console build only** (`memorynode-console`)

- `VITE_APP_SURFACE=console`
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — required for sign-in on the customer dashboard.

**App (founder) build only** (`memorynode-app`)

- `VITE_APP_SURFACE=app`

---

## How routing / “surface” works in code

At **build time**, Vite inlines `import.meta.env.VITE_APP_SURFACE` and `VITE_API_BASE_URL` into the bundle.

At **runtime**, `getAppSurface()` in `apps/dashboard/src/appSurface.ts` picks `console` vs `app` using:

1. Hostname equals `VITE_APP_HOSTNAME` (default `app.memorynode.ai`) → treat as **app**.
2. Path is `/founder` (or under it) → **app**.
3. Otherwise use the build-time `VITE_APP_SURFACE` value (`app` if it was `app`, else **console**).

`main.tsx` then renders `FounderApp` vs `App` and normalizes the path (e.g. app surface redirects to `/founder`).

So for production, set `VITE_APP_SURFACE` correctly **per deploy target** so behavior is correct even before hostname-based rules apply (e.g. previews).

---

## Local production builds

```bash
cp apps/dashboard/.env.console.production.example apps/dashboard/.env.production
# edit values, then:
pnpm --filter @memorynode/dashboard build
```

Or build both outputs:

```bash
export VITE_API_BASE_URL=https://api.memorynode.ai
export VITE_SUPABASE_URL=...
export VITE_SUPABASE_ANON_KEY=...
pnpm dashboard:build:prod-surfaces
```

---

## Verify after deploy

- [ ] `https://console.memorynode.ai` loads (customer console).
- [ ] `https://app.memorynode.ai/founder` loads (founder dashboard).
- [ ] Sign-in on console (Supabase); Google OAuth redirect allowlist includes the console origin.
- [ ] API calls succeed (cookies / CSRF as designed).
- [ ] `ALLOWED_ORIGINS` on the API Worker includes both `https://console.memorynode.ai` and `https://app.memorynode.ai`.

Security headers live in `apps/dashboard/public/_headers` (copied into the build).

---

## Database note (Overview tab)

Overview calls `GET /v1/dashboard/overview-stats` and needs migration **033** on the API database. See existing rollout notes in repo docs if Overview shows errors.

---

## Vercel (alternative)

`apps/dashboard/vercel.json` exists for headers. You would still need two Vercel projects (or two env configs) mirroring the two surfaces; the dual-build script still applies.
