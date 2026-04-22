# Dashboard Session Setup

How the MemoryNode Pages dashboards (`memorynode-console`, `memorynode-app`) authenticate users against the `memorynode-api` Worker.

Source of truth:

- Client: [apps/dashboard/src/supabaseClient.ts](../../apps/dashboard/src/supabaseClient.ts) and `apps/dashboard/src/apiClient.ts` (`ensureDashboardSession`).
- Worker handler: `handleDashboardSession` + `handleDashboardLogout` in [apps/api/src/workerApp.ts](../../apps/api/src/workerApp.ts).
- Schema: `infra/sql/023_dashboard_sessions.sql`, `024_dashboard_sessions_csrf.sql`.

## 1. Flow

```
user → dashboard (Supabase JS)
       │
       ├─ Supabase Auth (Google OAuth) → access_token (JWT)
       │
       ├─ POST /v1/dashboard/session
       │   body: { access_token, workspace_id }
       │   Worker:
       │     - verifies JWT via SUPABASE_JWT_SECRET
       │     - confirms workspace membership (is_workspace_member)
       │     - inserts dashboard_sessions row
       │     - sets Set-Cookie: mn_session=<opaque>; HttpOnly; Secure; SameSite=Lax
       │     - returns { csrf_token, expires_at }
       │
       └─ subsequent requests
           Cookie: mn_session=<opaque>
           x-csrf-token: <csrf_token>
           Worker verifies cookie + CSRF double-submit on every mutating request.
```

On sign-out the dashboard calls `POST /v1/dashboard/logout`, which deletes the row and clears the cookie.

## 2. Required env

### Worker (`memorynode-api`)

| Secret | Required for | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | Session handler (metadata lookups) | |
| `SUPABASE_JWT_SECRET` | JWT verification on `POST /v1/dashboard/session` | Must match the active Supabase project signing secret |
| `SUPABASE_ANON_KEY` | Metadata lookups (`auth.users`) via Supabase Auth API | |
| `SUPABASE_SERVICE_ROLE_KEY` | Writing to `dashboard_sessions` (Phase A) | |
| `ALLOWED_ORIGINS` | Must include the surface's hostname (`https://console.memorynode.ai`, `https://app.memorynode.ai`) | CORS gate in [workerApp.ts](../../apps/api/src/workerApp.ts) |

### Dashboard (Pages)

Only two Vite vars are required at build time (see `supabaseClient.ts:3-8`):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Plus `VITE_API_BASE_URL` (points to `https://api.memorynode.ai`) — used by `apiClient.ts`.

## 3. Cookie + CSRF contract

Set by the Worker on successful `POST /v1/dashboard/session`:

```
Set-Cookie: mn_session=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<ttl>
```

Response body:

```json
{ "csrf_token": "<base64url>", "expires_at": "<iso-timestamp>" }
```

Dashboard stores `csrf_token` in memory (not localStorage) and attaches it as `x-csrf-token` on every non-GET `/v1/*` call. The Worker compares `x-csrf-token` to `dashboard_sessions.csrf_token` in constant time. Mismatch → 403.

Session TTL is stored on the row; requests past `expires_at` return 401 and trigger a client-side re-login.

## 4. Worker verification steps

On every tenant request:

1. `verifyDashboardSession` ([apps/api/src/auth.ts](../../apps/api/src/auth.ts)) loads the `dashboard_sessions` row by the opaque token (SHA-256 hashed before lookup).
2. Rejects if expired, revoked, or absent.
3. Rate-limits via `RATE_LIMIT_DASHBOARD_SESSION_MAX` and standard per-key / per-workspace limits.
4. Emits an `api_audit_log` row with `actor_kind="dashboard_session"`.

## 5. Operator tasks

### 5.1 Force logout all sessions for a workspace

```sql
delete from dashboard_sessions
where workspace_id = '<uuid>';
```

### 5.2 Clean expired sessions

Runs automatically via admin cleanup:

```bash
curl -X POST https://api.memorynode.ai/admin/sessions/cleanup \
  -H "x-admin-token: $MASTER_ADMIN_TOKEN"
```

The same endpoint is hit by the scheduled GitHub Action.

### 5.3 Rotate `SUPABASE_JWT_SECRET`

1. Generate a new JWT secret in Supabase.
2. `wrangler secret put SUPABASE_JWT_SECRET`.
3. Redeploy.
4. Users will need to re-sign-in (their old access tokens no longer verify).

## 6. Common failures

| Symptom | Likely cause |
| --- | --- |
| `401 UNAUTHORIZED` on first `POST /v1/dashboard/session` | `SUPABASE_JWT_SECRET` mismatch with Supabase project |
| `403 FORBIDDEN` with `error_code=CSRF_MISMATCH` | `x-csrf-token` header missing or stale |
| CORS blocked in browser | `ALLOWED_ORIGINS` missing the surface hostname |
| `500` in `auth.users` lookup | `SUPABASE_ANON_KEY` unset |

Related: [DASHBOARD_DEPLOY.md](./DASHBOARD_DEPLOY.md), [SUPABASE_GOOGLE_OAUTH_SETUP.md](./SUPABASE_GOOGLE_OAUTH_SETUP.md).
