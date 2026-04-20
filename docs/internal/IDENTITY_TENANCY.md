## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# Identity and tenancy

**Auth:** Supabase Auth (email magic link + OAuth).  
**Mapping:** Auth user -> project membership (`workspace_members`) -> API keys scoped to project.

## Flow

1. **Login** → Supabase Auth (session with `user.id`).
2. **Project selection** -> User picks current project (stored client-side as `workspace_id` only — not secret).
3. **Dashboard calls** -> Use authenticated `user.id` and current `workspace_id`; API key is project-scoped.
4. **Memory search / user-scoped calls** -> Send `userId: session.user.id` (and optional `scope`); no hardcoded user.

## Enforcement map

| Source of truth        | Supabase Auth user ID |
|------------------------|------------------------|
| Project selection    | Stored client-side as `workspace_id` only — not secret |
| Authorization         | Server verifies project membership on every dashboard/API call |
| API scope              | `workspace_id` is mandatory for dashboard calls; server rejects mismatches |
| Revocation             | Membership removal invalidates access immediately |

## No stale project

- On **401/403** (membership or auth failure), the UI **forces project reselect** and **clears cached selection**: the dashboard apiClient calls `onUnauthorized`, which clears session state, shows “Session expired or access denied”, clears persisted `workspace_id`, and resets state so the user must sign in again or select project.
- Optional: subscribe to membership changes (or poll on load) so removal is reflected without a failed call.
