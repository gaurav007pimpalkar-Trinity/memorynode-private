# Dashboard session setup (Phase 0.2)

Follow these steps after implementing the dashboard session (no API key in browser).

---

## 1. Run the migrations so `dashboard_sessions` exists

Tables/columns are in **`infra/sql/023_dashboard_sessions.sql`** and **`infra/sql/024_dashboard_sessions_csrf.sql`** (adds `csrf_token` for Phase 0 CSRF).

### Option A: Use the project’s migration script (recommended)

1. **Get your Supabase Postgres URL**
   - Supabase Dashboard → **Project settings** → **Database**.
   - Copy **Connection string** (URI). Use “Direct connection” or “Session pool” depending on how you run migrations.
   - It looks like:  
     `postgresql://postgres.[ref]:[PASSWORD]@aws-0-[region].pooler.supabase.com:5432/postgres`

2. **Set the URL and run migrations**
   ```bash
   # From repo root. Use the variable name your project expects:
   export SUPABASE_DB_URL="postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require"
   # Or on Windows PowerShell:
   # $env:SUPABASE_DB_URL = "postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require"

   pnpm db:migrate
   ```
   This applies all pending migrations in `infra/sql/`, including `023_dashboard_sessions.sql`, and records them in `memorynode_migrations`.

3. **Confirm the table exists**
   - In Supabase: **SQL Editor** → run:
     ```sql
     select * from dashboard_sessions limit 0;
     ```
   - Or use the schema check:
     ```bash
     pnpm db:verify-schema
     ```

### Option B: Run the SQL file manually

If you don’t use `pnpm db:migrate` for this DB:

1. Open **Supabase Dashboard** → **SQL Editor**.
2. Paste the contents of **`infra/sql/023_dashboard_sessions.sql`**.
3. Run the script.
4. If you use `memorynode_migrations` for tracking, insert a row so the migration script doesn’t try to re-apply it:
   ```sql
   insert into memorynode_migrations (filename, checksum)
   values ('023_dashboard_sessions.sql', 'manual')
   on conflict (filename) do nothing;
   ```

---

## 2. Set `SUPABASE_ANON_KEY` in the Worker (required in production)

The Worker verifies the dashboard’s Supabase access token by calling **Supabase Auth API → Get User**. The project’s **anon (public) key** is required; in production, `check_config` (release:gate) fails if it is missing.

- **Production:** Set the secret so dashboard session creation works:
  1. Supabase Dashboard → **Project settings** → **API**.
  2. Copy **anon / public** key.
  3. Set it in the Worker (e.g. Cloudflare):
     ```bash
     pnpm --filter @memorynode/api exec wrangler secret put SUPABASE_ANON_KEY
     # Paste the anon key when prompted.
     ```
  4. Redeploy the Worker if needed.

---

## 3. Local dev: session cookie and HTTP

- **HTTPS (e.g. production):** The session cookie is set with **Secure**. Browsers only send it over HTTPS. Normal for production.
- **HTTP (e.g. `http://localhost`):** The code sets the cookie **without** `Secure` when the request URL is `http://` so the cookie is sent on localhost. No extra config.

If you use a tunnel (e.g. ngrok) with HTTPS for local dev, the cookie will be Secure and will work over that HTTPS URL.

---

## 4. How it works (recap)

- **API keys** are still created in the dashboard via Supabase RPC (`create_api_key`). The plaintext key is shown **once**; the dashboard does **not** store or send it.
- **Dashboard ↔ Worker:** All calls use the **session cookie** only (`mn_dash_session`). The dashboard calls `POST /v1/dashboard/session` with Supabase `access_token` and `workspace_id`; the Worker checks membership, creates a row in `dashboard_sessions`, and sets the httpOnly cookie. Later requests send that cookie; the Worker resolves the session and uses the linked workspace.
- **Sign out:** The dashboard calls `POST /v1/dashboard/logout` (and Supabase sign out). The Worker deletes the session and clears the cookie.

No long-lived API keys are stored in the browser; CI gate G2 enforces that.
