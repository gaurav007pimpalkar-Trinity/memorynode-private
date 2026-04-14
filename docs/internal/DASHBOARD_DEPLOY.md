# Console Deployment

Production deploy path for the MemoryNode console (overview, documents, requests, API keys, team, billing).

---

## URL

- **Production:** `https://console.memorynode.ai` (or your configured domain)
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
   - `VITE_SUPABASE_URL` — your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` — Supabase anon/public key
   - `VITE_API_BASE_URL` — `https://api.memorynode.ai`
5. **Auth (Google login):** Enable the Google provider in Supabase, configure Google Cloud redirect URI, and allowlist `https://console.memorynode.ai`. See [SUPABASE_GOOGLE_OAUTH_SETUP.md](./SUPABASE_GOOGLE_OAUTH_SETUP.md).
6. **Custom domain:** Settings → Custom domains → Add `console.memorynode.ai`.
7. **DNS:** In your DNS provider, add a CNAME for `app` (or `app.memorynode`) pointing to the Pages URL Cloudflare shows (e.g. `memorynode-dashboard.pages.dev`), or use Cloudflare DNS and add the domain in the Pages project.

Security headers (CSP, X-Content-Type-Options, etc.) are in `apps/dashboard/public/_headers` and are included in the build output.

### Option B: Direct upload (CLI)

From repo root:

```bash
pnpm install
pnpm --filter @memorynode/dashboard build
cd apps/dashboard
pnpm exec wrangler pages deploy dist --project-name=memorynode-dashboard
```

Create the project once in the dashboard if needed: Workers & Pages → Create → Pages → Direct Upload → create project `memorynode-dashboard`. Then add env vars in the dashboard and set custom domain `console.memorynode.ai`.

**Required env vars (Cloudflare Pages project settings):**
- `VITE_SUPABASE_URL` — Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — Supabase anon/public key  
- `VITE_API_BASE_URL` — e.g. `https://api.memorynode.ai`

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

Ensure `ALLOWED_ORIGINS` in the API Worker includes your console URL (e.g. `https://console.memorynode.ai`). Set in Cloudflare Worker vars or `wrangler secret` / dashboard env for the API.

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
- [ ] Sign in works (Supabase Auth); for Google, follow [SUPABASE_GOOGLE_OAUTH_SETUP.md](./SUPABASE_GOOGLE_OAUTH_SETUP.md) and confirm **Continue with Google** → Google consent → return signed in
- [ ] Session → workspace → API key flow works
- [ ] API calls succeed (session cookie, CSRF)
- [ ] **Overview** tab shows numeric metrics (not a persistent error); timeframe **1d / 7d / 30d / All** updates counts after migration **033** and API deploy
