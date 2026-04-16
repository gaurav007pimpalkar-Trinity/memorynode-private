# Frontend Deployment

Production deploy path for the separated MemoryNode frontends:
- `memorynode-console` -> `https://console.memorynode.ai`
- `memorynode-app` -> `https://app.memorynode.ai/founder`

---

## URLs

- **Console:** `https://console.memorynode.ai`
- **Founder app:** `https://app.memorynode.ai/founder`
- **Local:** `pnpm --filter @memorynode/dashboard dev` → http://localhost:5173

---

## Deploy (Cloudflare Pages)

### Option A: Connect repository (recommended)

1. **Cloudflare dashboard** → Workers & Pages → Create application → Pages → Connect to Git.
2. Select this repo and branch (e.g. `main`).
3. **Build configuration:**
   - **Root directory:** leave empty (repo root).
   - **Build command:** `pnpm install && pnpm --filter @memorynode/dashboard build`
   - **Build output directory:** `apps/dashboard/dist` — when building from repo root, the output is under the repo; use this path exactly (not `dist`).
4. **Environment variables** (Settings → Environment variables → Production):
   - `VITE_API_BASE_URL` — `https://api.memorynode.ai`
   - `VITE_APP_SURFACE` — `console` for `memorynode-console`, `app` for `memorynode-app`
   - `VITE_CONSOLE_BASE_URL` — `https://console.memorynode.ai`
   - `VITE_SUPABASE_URL` — required for `memorynode-console`
   - `VITE_SUPABASE_ANON_KEY` — required for `memorynode-console`
5. **Console auth:** Enable the Google provider in Supabase, configure Google Cloud redirect URI, and allowlist `https://console.memorynode.ai`. See [SUPABASE_GOOGLE_OAUTH_SETUP.md](./SUPABASE_GOOGLE_OAUTH_SETUP.md).
6. **Custom domains:**
   - `memorynode-console` -> `console.memorynode.ai`
   - `memorynode-app` -> `app.memorynode.ai`
7. **Founder routing:** direct navigation to `/founder` is supported by `apps/dashboard/public/_redirects`.

Security headers (CSP, X-Content-Type-Options, etc.) are in `apps/dashboard/public/_headers` and are included in the build output.

### Option B: Direct upload (CLI)

From repo root:

```bash
pnpm install
pnpm --filter @memorynode/dashboard build
cd apps/dashboard
pnpm exec wrangler pages deploy dist --project-name=memorynode-console
```

Create the projects once in the dashboard if needed:
- `memorynode-console`
- `memorynode-app`

Then add env vars per project and set custom domains `console.memorynode.ai` and `app.memorynode.ai`.

**Console env vars (`memorynode-console`):**
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_API_BASE_URL=https://api.memorynode.ai`
- `VITE_APP_SURFACE=console`
- `VITE_CONSOLE_BASE_URL=https://console.memorynode.ai`

**Founder env vars (`memorynode-app`):**
- `VITE_API_BASE_URL=https://api.memorynode.ai`
- `VITE_APP_SURFACE=app`
- `VITE_CONSOLE_BASE_URL=https://console.memorynode.ai`

---

## Vercel (alternative)

The dashboard also has `apps/dashboard/vercel.json` for headers. Use Vercel if you prefer:

```bash
cd apps/dashboard
vercel --prod
```

Set the same env vars in Vercel and add custom domain `console.memorynode.ai`.

---

## CORS

Ensure `ALLOWED_ORIGINS` in the API Worker includes both frontend origins:
- `https://console.memorynode.ai`
- `https://app.memorynode.ai`

---

## Database: Overview metrics (migration 033)

The console Overview calls **`GET /v1/dashboard/overview-stats`**, which uses the Postgres function **`dashboard_console_overview_stats`** from:

`infra/sql/033_dashboard_console_overview_stats.sql`

**Apply this migration to the same database your API uses** (Supabase project → SQL editor, or `pnpm db:migrate` with `SUPABASE_DB_URL` / `DATABASE_URL` per repo docs). If 033 is not applied, Overview shows a **DB_ERROR** badge instead of live counts.

**Rollout order (recommended):**

1. Apply **033** (and any pending migrations) to production Postgres.
2. Deploy the **API** Worker (route `/v1/dashboard/overview-stats` must exist).
3. Deploy the **console** (Pages) so the UI matches the API.

---

## Post-deploy

- [ ] `https://console.memorynode.ai` loads
- [ ] `https://app.memorynode.ai/founder` loads
- [ ] Sign in works (Supabase Auth); for Google, follow [SUPABASE_GOOGLE_OAUTH_SETUP.md](./SUPABASE_GOOGLE_OAUTH_SETUP.md) and confirm **Continue with Google** → Google consent → return signed in
- [ ] Session → workspace → API key flow works
- [ ] API calls succeed (session cookie, CSRF)
- [ ] Founder app requires valid admin token to load metrics
- [ ] **Overview** tab shows numeric metrics (not a persistent error); timeframe **1d / 7d / 30d / All** updates counts after migration **033** and API deploy
