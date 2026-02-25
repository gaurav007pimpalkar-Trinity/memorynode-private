# Identity and tenancy

**Auth:** Supabase Auth (email magic link + OAuth).  
**Mapping:** Auth user → workspace membership (`workspace_members`) → API keys scoped to workspace.

## Flow

1. **Login** → Supabase Auth (session with `user.id`).
2. **Workspace selection** → User picks current workspace (stored client-side as `workspace_id` only — not secret).
3. **Dashboard calls** → Use authenticated `user.id` and current `workspace_id`; API key is workspace-scoped.
4. **Memory search / user-scoped calls** → Send `user_id: session.user.id` (and optional namespace); no hardcoded user.

## Enforcement map

| Source of truth        | Supabase Auth user ID |
|------------------------|------------------------|
| Workspace selection    | Stored client-side as `workspace_id` only — not secret |
| Authorization         | Server verifies workspace membership on every dashboard/API call |
| API scope              | `workspace_id` is mandatory for dashboard calls; server rejects mismatches |
| Revocation             | Membership removal invalidates access immediately |

## No stale workspace

- On **401/403** (membership or auth failure), the UI **forces workspace reselect** and **clears cached workspace selection**: the dashboard apiClient calls `onUnauthorized`, which clears session state, shows “Session expired or access denied”, clears persisted `workspace_id`, and resets workspace state so the user must sign in again or select workspace.
- Optional: subscribe to membership changes (or poll on load) so removal is reflected without a failed call.
