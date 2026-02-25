# Beta Troubleshooting

Use this table to move from symptom -> likely cause -> fix quickly.

## 1) Symptom Matrix

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
| PayU webhook failures | Invalid hash/secret, processing error, or missing workspace mapping | Validate `PAYU_MERCHANT_KEY` and `PAYU_MERCHANT_SALT`; inspect `webhook_failed`, `billing_webhook_signature_invalid`, and `billing_webhook_workspace_not_found` logs; see docs/BILLING_RUNBOOK.md |

## 2) Explicit Checks

1. `BASE_URL` check
   - Expected: absolute URL, no trailing path (for example `https://api.example.com`)
2. Authorization format check
   - Expected: `Authorization: Bearer <API_KEY>`
3. Token type check
   - Admin routes: `x-admin-token`
   - Runtime routes: API key (`Authorization` or `x-api-key`)
4. Workspace check
   - Ensure API key belongs to intended `workspace_id`
5. User scope check
   - Same `user_id` for ingest and retrieval
6. Namespace check
   - Same `namespace` for ingest and retrieval
7. Rate limit check
   - On `429`, retry with backoff (`250ms`, `500ms`, `1s`, `2s`, jitter)
8. Supabase/RLS check
   - Look for `DB_ERROR`, `permission denied`, `RLS` failures in logs

## 3) Support Issue Template

Copy/paste this in a GitHub issue or support ticket:

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

## 4) Useful Commands

- Beta end-to-end check:
  - `BASE_URL=... API_KEY=... USER_ID=... NAMESPACE=... pnpm beta:verify`
- Admin + auth baseline:
  - `TARGET_ENV=staging STAGING_BASE_URL=... ADMIN_TOKEN=... pnpm release:staging:validate`
- E2E script checks:
  - `pnpm e2e:verify`
