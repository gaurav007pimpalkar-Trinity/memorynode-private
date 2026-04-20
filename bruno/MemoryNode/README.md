# MemoryNode Bruno Collection

Git-friendly API collection for beta onboarding and support reproduction.

## Setup

1. Open the `bruno/MemoryNode` folder in Bruno.
2. Select environment `beta`.
3. Fill variables:
   - `base_url`
   - `admin_token`
   - `api_key`
   - `workspace_id` (project ID in admin routes)
   - `user_id` (preferred public input: `userId`)
   - `namespace` (preferred public input: `scope`)
   - `query_id` (from Search History response)
   - `eval_set_id` (from List/Create Eval Set response)

## Run order

1. `Healthz`
2. `Admin Create Workspace` (creates project; copy `workspace_id` into variable)
3. `Admin Create API Key` (copy `api_key` into variable)
4. `Usage Today`
5. `Ingest Memory`
6. `Search`
7. `Context`
8. `Search History`
9. `Replay Search`
10. `List Eval Sets`
11. `Create Eval Set`
12. `Run Eval Set`
13. `Context Feedback`

Optional:
- `Export`
- `Import`

Notes:
- Admin routes require `x-admin-token`.
- Runtime routes require API key auth (`Authorization: Bearer {{api_key}}`).
