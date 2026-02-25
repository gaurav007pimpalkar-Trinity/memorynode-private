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

Use template: § 7) Troubleshooting — Support Issue Template (below).

---

## 7) First-run flow (merged from FIRST_RUN_FLOW.md)

**Flow (dashboard):** 1) Sign up — GitHub OAuth or magic link via Supabase Auth. 2) Create or select workspace — Workspaces tab → "Create workspace" or pick existing. 3) Get API key — API Keys tab → "Create key" → copy plaintext (shown once). Store securely. 4) Ingest one memory — Use curl or your app; see QUICKSTART §7. 5) Run one search — Memory Browser tab or API.

**Success metrics:** First-run success rate = % of new signups who complete workspace → key → ingest → search within 10 min. Measurable via activation events (`first_ingest_success`, `first_search_success`); optional in-app funnel tracking.

**In-app hints (optional):** After signup: "Create a workspace to get started." After workspace: "Create an API key to call the API." After key: "Ingest a memory, then search in Memory Browser."

**Quickstart reference:** Clone, install, env = QUICKSTART §1–2; Migrations = §3; Run API + dashboard = §4–5; Get API key = §6; Curl smoke = §7.

---

## 8) Troubleshooting (merged from TROUBLESHOOTING_BETA.md)

### Symptom matrix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `GET /healthz` fails or times out | Wrong `BASE_URL`, DNS, deployment down | Verify `BASE_URL`, test `curl $BASE_URL/healthz`, confirm deploy status |
| `401 UNAUTHORIZED` | Missing or invalid `Authorization` header | Send `Authorization: Bearer <API_KEY>` exactly (or `x-api-key`) |
| `403` on admin routes | Using API key instead of admin token | Use `x-admin-token: <MASTER_ADMIN_TOKEN>` for `/v1/workspaces` and `/v1/api-keys` |
| `401/403` on runtime routes | Using admin token where API key is expected | Use API key auth on `/v1/memories`, `/v1/search`, `/v1/context`, `/v1/usage/today` |
| Search returns empty results | `user_id` mismatch | Ingest and query with the same `user_id` |
| Search/context empty for expected data | `namespace` mismatch | Ensure ingest and retrieval use the same `namespace` |
| `429 rate_limited` | Per-key rate limit exceeded | Exponential backoff + jitter; reduce burst traffic; honor `Retry-After` |
| Unexpected cross-workspace behavior | `workspace_id` mismatch in admin provisioning | Confirm key was created for intended `workspace_id` |
| `500 DB_ERROR` / permission error text | Supabase/RLS/migration issue | Check DB migration status (`pnpm db:migrate`, `pnpm db:verify-rls`) and Supabase credentials |
| PayU webhook failures | Invalid hash/secret, processing error, or missing workspace mapping | Validate `PAYU_MERCHANT_KEY` and `PAYU_MERCHANT_SALT`; inspect webhook logs; see docs/BILLING_RUNBOOK.md |

### Explicit checks

1. BASE_URL — absolute URL, no trailing path (e.g. `https://api.example.com`).  
2. Authorization format — `Authorization: Bearer <API_KEY>`.  
3. Token type — Admin routes: `x-admin-token`; Runtime routes: API key.  
4. Workspace — API key belongs to intended `workspace_id`.  
5. User scope — same `user_id` for ingest and retrieval.  
6. Namespace — same `namespace` for ingest and retrieval.  
7. Rate limit — on 429, retry with backoff (250ms, 500ms, 1s, 2s, jitter).  
8. Supabase/RLS — look for `DB_ERROR`, `permission denied`, `RLS` in logs.

### Support issue template

Copy/paste for GitHub issue or support ticket:

```
## Beta Support Issue

- Timestamp (UTC):
- Environment (local/staging/prod):
- BASE_URL:
- Route + method:
- HTTP status:
- request_id (if available):
- workspace_id (or redacted):
- user_id:
- namespace:

### Minimal request payload (redacted)
{"user_id":"<redacted>","namespace":"<redacted>","query":"<redacted>"}

### What I expected

### What happened

### Logs/snippets (redacted)
```

### Useful commands

- Beta end-to-end: `BASE_URL=... API_KEY=... USER_ID=... NAMESPACE=... pnpm beta:verify`
- Admin + auth baseline: `TARGET_ENV=staging STAGING_BASE_URL=... ADMIN_TOKEN=... pnpm release:staging:validate`
- E2E: `pnpm e2e:verify`
