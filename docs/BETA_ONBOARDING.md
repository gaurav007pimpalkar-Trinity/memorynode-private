# MemoryNode Beta Onboarding

MemoryNode is a memory API for AI applications: you store user facts/conversation snippets, then retrieve relevant context for later prompts.  
This beta is for developers integrating memory into chat agents, copilots, and internal assistants.

## 1) Prereqs

- Node.js 20+
- pnpm 9+
- `curl` or Postman/Bruno (for quick API calls)
- Access to a MemoryNode workspace + API key

## 2) Getting Access

1. Create (or get invited to) a workspace.
2. Create an API key for that workspace (shown once at creation).
3. Keep the key secure and send it as `Authorization: Bearer <API_KEY>` or `x-api-key: <API_KEY>`.

Admin-only bootstrap endpoints (operators):
- `POST /v1/workspaces` with `x-admin-token`
- `POST /v1/api-keys` with `x-admin-token`

## 3) Fastest Path (10-15 min)

Pick one:

1. Bruno collection (recommended for support reproducibility):
   - Open `bruno/MemoryNode`
   - Set variables (`base_url`, `admin_token`, `api_key`, `workspace_id`, `user_id`, `namespace`)
   - Run: health -> workspace -> api key -> usage -> ingest -> search -> context
2. Node quickstart example:
   - `node examples/node-quickstart/index.mjs`
   - Uses env vars: `BASE_URL`, `API_KEY`, `USER_ID`, `NAMESPACE`

## 4) Core Concepts

### `workspace_id` vs API key
- `workspace_id` identifies tenant data ownership.
- API key proves caller identity and is tied to one workspace.
- Most runtime calls use only API key; workspace is derived server-side.

### `user_id` scoping
- Every ingest/search/context call includes `user_id`.
- Retrieval is scoped by `user_id`; mismatches are a common cause of empty results.

### `namespace` scoping
- Use `namespace` to isolate projects/features/environments inside one workspace.
- Search/context only returns rows in the same namespace (or default namespace if omitted).

### TTL and deletion basics
- There is no automatic TTL endpoint in the current beta.
- Use explicit deletion (`DELETE /v1/memories/:id`) and namespace partitioning/rotation for lifecycle control.

## 5) Common Gotchas

- `401` / `403`:
  - Usually wrong/missing auth header or wrong token type.
  - Fix: use `Authorization: Bearer <API_KEY>` for runtime routes; use `x-admin-token` only for admin routes.
- `429`:
  - Rate limit hit.
  - Fix: exponential backoff + retry with jitter.
- Empty search/context:
  - Often wrong `user_id` or `namespace`, or no prior ingest.
  - Fix: verify ingest succeeded for same `user_id` + `namespace`, then retry query.

## 6) Bug Report Requirements

When filing beta bugs, include:

- `timestamp` (UTC)
- `route` and HTTP method
- HTTP `status`
- `request_id` (if available from headers/logs)
- `workspace_id` (or redacted form)
- minimal request payload (remove secrets)
- expected vs actual behavior

Use template: `docs/TROUBLESHOOTING_BETA.md` -> "Support Issue Template".
