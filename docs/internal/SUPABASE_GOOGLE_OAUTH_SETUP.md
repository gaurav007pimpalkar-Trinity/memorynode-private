# Supabase Google OAuth Setup

How the MemoryNode Pages dashboards exchange a Supabase Google OAuth access token for a server-side session on the `memorynode-api` Worker.

Only the code-side steps below are directly verifiable from this repo. The Supabase and Google Cloud steps at the end are flagged as out-of-scope for the code-only scan and must be verified against the live Supabase project.

## 1. What the code actually does

### 1.1 Dashboard Supabase client

[apps/dashboard/src/supabaseClient.ts:1-22](../../apps/dashboard/src/supabaseClient.ts):

```ts
const supabase = createClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    detectSessionInUrl: true,
  },
});
```

Required build-time env:

- `VITE_SUPABASE_URL` — Supabase project URL.
- `VITE_SUPABASE_ANON_KEY` — Supabase anon key.

Missing either surfaces as `supabaseEnvError` in the UI.

### 1.2 Browser handoff

After Supabase completes the Google OAuth redirect, the dashboard reads the access token and calls `ensureDashboardSession(access_token, workspace_id)` in `apps/dashboard/src/apiClient.ts`. That function POSTs to `/v1/dashboard/session`:

```
POST /v1/dashboard/session
Content-Type: application/json

{
  "access_token": "<Supabase JWT>",
  "workspace_id": "<uuid>"
}
```

### 1.3 Worker verification

`handleDashboardSession` in [apps/api/src/workerApp.ts](../../apps/api/src/workerApp.ts) does:

1. Verify the Supabase JWT using `SUPABASE_JWT_SECRET`.
2. Lookup the user via Supabase Auth `Get User` (requires `SUPABASE_ANON_KEY`).
3. Confirm workspace membership (`workspace_members` via `is_workspace_member`).
4. Insert a row into `dashboard_sessions` with an opaque server token + CSRF token.
5. Respond with `Set-Cookie: mn_session=<opaque>; HttpOnly; Secure; SameSite=Lax` and body `{ csrf_token, expires_at }`.

See [DASHBOARD_SESSION_SETUP.md](./DASHBOARD_SESSION_SETUP.md) for the full request-time verification contract.

### 1.4 Worker env required

Set on `memorynode-api` via `wrangler secret put`:

| Secret | Why |
| --- | --- |
| `SUPABASE_URL` | Supabase Auth API base |
| `SUPABASE_ANON_KEY` | Calls `Get User` on the JWT |
| `SUPABASE_JWT_SECRET` | Verifies the JWT signature |
| `SUPABASE_SERVICE_ROLE_KEY` | Writes `dashboard_sessions` (Phase A) |

`ALLOWED_ORIGINS` must include the surface hostnames (`https://console.memorynode.ai`, `https://app.memorynode.ai`) or the Worker rejects the POST at the CORS gate.

## 2. Supabase + Google configuration (manual — verify in the live Supabase project)

These steps are outside the code-only scan. Treat them as a checklist and verify each item in the Supabase and Google Cloud consoles before going live.

1. **Google Cloud → OAuth consent screen** published for the intended user set.
2. **Google Cloud → Credentials** — create an OAuth 2.0 Web application client. Capture the client ID and secret.
3. **Authorized redirect URIs** must include the Supabase callback: `https://<project-ref>.supabase.co/auth/v1/callback`.
4. **Supabase → Authentication → Providers → Google** — paste the Google client ID and secret, enable the provider.
5. **Supabase → Authentication → URL Configuration → Redirect URLs** — add the production surfaces: `https://console.memorynode.ai`, `https://app.memorynode.ai`, plus the staging and localhost hosts you use.
6. **Supabase → Authentication → JWT Settings** — confirm the signing secret matches the `SUPABASE_JWT_SECRET` stored on the Worker. If you rotate here, you must `wrangler secret put` the new value and redeploy the Worker.
7. **Supabase → Project Settings → API** — capture the `Project URL`, `anon key` (build-time for dashboards), and `service_role key` (Worker secret).

## 3. Validation

After deploy:

1. Sign in via the dashboard. Browser should return from Supabase with a Supabase session cookie (client-side).
2. Network tab should show `POST /v1/dashboard/session` responding 200 with a `Set-Cookie: mn_session=...` header and `{ csrf_token, expires_at }` in the body.
3. A subsequent mutating call (e.g. `PATCH /v1/profile/pins`) must include the cookie and an `x-csrf-token` header matching the returned CSRF token.
4. `POST /v1/dashboard/logout` clears the cookie (`Set-Cookie: mn_session=; Max-Age=0`).

## 4. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| 401 on `POST /v1/dashboard/session` | `SUPABASE_JWT_SECRET` mismatch with Supabase project | Rotate and `wrangler secret put` |
| CORS blocked in browser | Surface hostname missing from `ALLOWED_ORIGINS` | Update secret + redeploy |
| User signs in but Supabase redirects to the wrong hostname | Supabase redirect URL list missing the surface | Add in Supabase → Authentication → URL Configuration |
| 500 with Supabase user lookup error | `SUPABASE_ANON_KEY` unset | `wrangler secret put SUPABASE_ANON_KEY` |

## 5. Related

- [DASHBOARD_SESSION_SETUP.md](./DASHBOARD_SESSION_SETUP.md) — server-side session contract.
- [DASHBOARD_DEPLOY.md](./DASHBOARD_DEPLOY.md) — Pages build/deploy.
- [IDENTITY_TENANCY.md](./IDENTITY_TENANCY.md) — isolation rules for session callers.
