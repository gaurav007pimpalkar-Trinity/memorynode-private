# MemoryNode API usage

Canonical HTTP reference for the `memorynode-api` Cloudflare Worker. Source of truth: code in `apps/api/src/`. Regenerated OpenAPI spec at [docs/external/openapi.yaml](./openapi.yaml) (run `pnpm openapi:gen`).

- Production base: `https://api.memorynode.ai`
- Hosted MCP base: `https://mcp.memorynode.ai` (same Worker)
- Staging base: `https://api-staging.memorynode.ai`
- Local dev: `http://127.0.0.1:8787`

## 1. Authentication

Dispatched in [apps/api/src/auth.ts](../../apps/api/src/auth.ts) and [apps/api/src/workerApp.ts](../../apps/api/src/workerApp.ts).

| Mode | Trigger | Validation | Uses |
| --- | --- | --- | --- |
| API key (K) | `Authorization: Bearer <key>` or `x-api-key: <key>` | SHA-256 of key + `API_KEY_SALT` then `authenticate_api_key(p_key_hash)` RPC | All `/v1/*` tenant routes |
| Dashboard session (S) | `Cookie: mn_session=<opaque>` + `x-csrf-token` | Row in `dashboard_sessions` + CSRF double-submit | `/v1/*` tenant routes from browser |
| Admin (A) | `x-admin-token` | Equality against `MASTER_ADMIN_TOKEN` or HMAC-SHA256 signed form; optional IP allowlist (`ADMIN_ALLOWED_IPS`); `ADMIN_BREAK_GLASS` | `/admin/*`, `/v1/admin/*` |
| Memory webhook (H) | `X-MN-Webhook-Signature` | HMAC-SHA256 over raw body keyed by `memory_ingest_webhooks.signing_secret` for the target workspace | `POST /v1/webhooks/memory` only |
| PayU webhook (H) | form body | Reverse SHA-512 over PayU fields, or HMAC-SHA256 fallback over raw body keyed by `PAYU_WEBHOOK_SECRET` (`x-payu-webhook-signature`) | `POST /v1/billing/webhook` only |
| Internal MCP (I) | `x-internal-mcp: 1` + `x-internal-secret: <MCP_INTERNAL_SECRET>` | Constant-time compare | Internal hosted-MCP → REST subrequests |
| Public (P) | — | — | `/healthz`, `/ready`, `/v1/health` |

API keys created through `POST /v1/api-keys` are rate-limited at **15 RPM** for the first 48 h after `api_keys.created_at`; after that the default is **60 RPM** per key. See [packages/shared/src/plans.ts](../../packages/shared/src/plans.ts).

## 2. Middleware order

From `handleRequestImpl` in [apps/api/src/workerApp.ts](../../apps/api/src/workerApp.ts):

1. Request-id resolve, CORS + security headers ensemble.
2. Short-circuit health endpoints (`/healthz`, `/ready`, `/v1/health`).
3. CORS deny if `Origin` is not in `ALLOWED_ORIGINS` (except hosted MCP paths).
4. `enforceRuntimeConfigGuards` and `ensureRateLimitDo`.
5. `OPTIONS` short-circuit.
6. `assertBodySize` (bounded by `MAX_BODY_BYTES` / `MAX_IMPORT_BYTES`).
7. `KNOWN_PATH_ALLOWED_METHODS` 405 gate with `Allow:` header.
8. Production dashboard `ALLOWED_ORIGINS` gate.
9. `createSupabaseClient(env)` + `db_access_path_selected` log.
10. Hosted MCP path → IP rate limit → `handleHostedMcpRequest`.
11. Dashboard session POST/logout inline.
12. If `DISABLE_SERVICE_ROLE_REQUEST_PATH=1`: reject admin and billing-webhook routes with `503 CONTROL_PLANE_ONLY`.
13. Build `handlerDeps`, instantiate factories, call `route()`.
14. `404` if `route()` returns null.
15. Catch: `ApiError`-shaped response with `error_code`; else `500 INTERNAL`.
16. Finally: `emitAuditLog`, `request_completed` structured log, `persistApiRequestEvent`.

## 3. Error envelope

Errors emitted by [apps/api/src/workerApp.ts:1093-1120](../../apps/api/src/workerApp.ts) use:

```json
{ "error": { "code": "STRING_CODE", "message": "human readable" } }
```

Typical codes: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `CAP_EXCEEDED`, `TRIAL_EXPIRED`, `COST_BUDGET_EXCEEDED`, `CONTROL_PLANE_ONLY`, `INTERNAL`. Correlate responses with the `x-request-id` header.

## 4. Rate limits, concurrency, quotas

All defined in [apps/api/src/auth.ts](../../apps/api/src/auth.ts), [apps/api/src/usage/quotaReservation.ts](../../apps/api/src/usage/quotaReservation.ts), and [packages/shared/src/plans.ts](../../packages/shared/src/plans.ts).

| Control | Default | Source |
| --- | --- | --- |
| Per-key RPM | 60 (15 for new keys, 48 h) | `RATE_LIMIT_MAX`, `RATE_LIMIT_RPM_NEW_KEY` |
| Per-workspace RPM | 120 (300 for `scale`) | `WORKSPACE_RPM_DEFAULT`, `WORKSPACE_RPM_SCALE` |
| Per-workspace in-flight | 8 | `WORKSPACE_CONCURRENCY_MAX`, TTL 30000 ms |
| Cost/minute burst | 15 INR | `WORKSPACE_COST_PER_MINUTE_CAP_INR` |
| Daily and period caps | atomic via Postgres | `reserve_usage_if_within_cap` / `commit_usage_reservation` |
| Global AI cost budget | fail-closed (prod) | `AI_COST_BUDGET_INR`, 60 s cache |

## 5. Plans

From [packages/shared/src/plans.ts](../../packages/shared/src/plans.ts). `PlanId = "launch" | "build" | "deploy" | "scale" | "scale_plus"`. Checkout-accepted: `launch`, `build`, `deploy`, `scale`; `scale_plus` is custom/legacy.

| Plan | INR | Period (d) | Writes | Reads | Embed tok | Gen tok | Storage GB | Retention (d) | Workspace RPM |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| launch | 399 | 7 | 250 | 1 000 | 100 000 | 150 000 | 0.5 | 30 | 120 |
| build | 999 | 30 | 1 200 | 4 000 | 600 000 | 1 000 000 | 2 | 90 | 120 |
| deploy | 2 999 | 30 | 5 000 | 15 000 | 3 000 000 | 5 000 000 | 10 | 180 | 120 |
| scale | 8 999 | 30 | 20 000 | 60 000 | 12 000 000 | 20 000 000 | 50 | 365 | 300 |
| scale_plus | custom | n/a | 100 000 | 200 000 | 200 000 000 | 200 000 000 | 250 | 365 | 300 |

Overage rates per 1 k / per 1 M tok / per GB-mo are hard-coded per plan in `plans.ts:87-203`.

## 6. Routes (tenant-facing)

Dispatch is in [apps/api/src/router.ts](../../apps/api/src/router.ts). `K` = API key. `S` = dashboard session.

### 6.1 Memories

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/memories` | K/S | Create a memory; embed, chunk, optional extraction up to 10 child memories |
| POST | `/v1/memories/conversation` | K/S | Create from transcript or messages (transforms → `/v1/memories`) |
| GET | `/v1/memories` | K/S | Paginated list, filters: `namespace`, `user_id`, `owner_id`, `owner_type`, `memory_type`, `start_time`, `end_time`, `metadata` |
| GET | `/v1/memories/:id` | K/S | Single memory |
| DELETE | `/v1/memories/:id` | K/S | Cascade delete with chunks and links |
| POST | `/v1/memories/:id/links` | K/S | Create `memory_links` edge (unique per workspace) |
| DELETE | `/v1/memories/:id/links` | K/S | Delete edge |
| POST | `/v1/ingest` | K/S | Discriminated dispatch → memory / conversation / import |
| POST | `/v1/import` | K/S | Bulk import from base64 artifact, quota-checked before insert |

### 6.2 Search and context

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/search` | K/S | Embed query, pgvector search, optional rerank; header `x-save-history: 1` inserts `search_query_history` |
| POST | `/v1/context` | K/S | Search + context assembly with citations and linked memories |
| GET | `/v1/context/explain` | K/S | Per-chunk rank, recency, importance breakdown |
| POST | `/v1/context/feedback` | K/S | Insert feedback row |
| GET | `/v1/search/history` | K/S | Saved queries (paginated) |
| POST | `/v1/search/replay` | K/S | Rerun from history by `query_id` |
| POST | `/v1/explain/answer` | K/S | OpenAI completion over assembled context |
| PATCH | `/v1/profile/pins` | K/S | Update pinned memories |

### 6.3 Usage, audit, pruning

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/usage/today` | K/S | Caps vs consumed reads/writes/tokens |
| GET | `/v1/audit/log` | K/S | Paginated `api_audit_log` rows |
| GET | `/v1/pruning/metrics` | K/S | `workspace_pruning_metrics` RPC |

### 6.4 Evals

| Method | Path | Auth |
| --- | --- | --- |
| GET,POST | `/v1/evals/sets` | K/S |
| DELETE | `/v1/evals/sets/:id` | K/S |
| GET,POST | `/v1/evals/items` | K/S |
| DELETE | `/v1/evals/items/:id` | K/S |
| POST | `/v1/evals/run` | K/S |

### 6.5 Connectors

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/v1/connectors/settings` | K/S |
| PATCH | `/v1/connectors/settings` | K/S |

### 6.6 Workspaces and API keys

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/v1/workspaces` | admin-scoped K or A |
| POST | `/v1/api-keys` | K/S |
| GET | `/v1/api-keys` | K/S |
| POST | `/v1/api-keys/revoke` | K/S |

### 6.7 Billing

All PayU. The Stripe portal endpoint is retired and returns `410 Gone`.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/billing/status` | K/S | `select workspace_entitlements` |
| POST | `/v1/billing/checkout` | K/S | Body: `{plan, firstname?, email?, phone?}`. Inserts `payu_transactions`, computes SHA-512 request hash, returns `{url, method:"POST", fields}` for the PayU form. |
| POST | `/v1/billing/portal` | K/S | **Always 410 Gone.** |
| POST | `/v1/billing/webhook` | H | PayU callback. Verifies reverse SHA-512 (or HMAC-SHA256 fallback), calls PayU verify API, upserts entitlements. |
| POST | `/v1/webhooks/memory` | H | HMAC-SHA256 via `X-MN-Webhook-Signature`. |

### 6.8 Dashboard

Browser console routes use the dashboard session cookie (`S`) and request-scoped Supabase execution. **Mutating** `POST` routes also require a valid `x-csrf-token` (double-submit with the session bootstrap). JSON bodies use `{ ok: true, data: … }` on success or `{ ok: false, error: { code, message, details? } }` on failure unless noted.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/v1/dashboard/bootstrap` | Supabase JWT in body | `{ access_token, workspace_name? }`. Pre-cookie: resolves or creates the user’s default workspace via `create_workspace` when none exists; then the client calls `/v1/dashboard/session` with the chosen `workspace_id`. |
| POST | `/v1/dashboard/session` | Supabase JWT in body | `{access_token, workspace_id}`; verifies via `SUPABASE_JWT_SECRET`, inserts `dashboard_sessions`, sets HttpOnly cookie, returns `csrf_token`. |
| POST | `/v1/dashboard/logout` | S | Deletes session, clears cookie. |
| GET | `/v1/dashboard/overview-stats` | S | `dashboard_console_overview_stats` RPC. |
| GET | `/v1/dashboard/workspaces` | S | Lists workspaces the signed-in user belongs to (`id`, `name`, `role`). |
| POST | `/v1/dashboard/workspaces` | S + CSRF | `{ name }`; `create_workspace` RPC. |
| GET | `/v1/dashboard/api-keys` | S | Query `workspace_id?` (defaults to active session workspace; must match session). `list_api_keys` RPC. |
| POST | `/v1/dashboard/api-keys` | S + CSRF | `{ workspace_id, name }`; `create_api_key` RPC (returns plaintext key once). |
| POST | `/v1/dashboard/api-keys/revoke` | S + CSRF | `{ api_key_id }`; `revoke_api_key` RPC. |
| GET | `/v1/dashboard/members` | S | Query `workspace_id?` (must match session). Direct `workspace_members` read for the workspace. |
| GET | `/v1/dashboard/invites` | S | Query `workspace_id?` (must match session). Lists `workspace_invites` for the workspace. |
| POST | `/v1/dashboard/invites` | S + CSRF | `{ workspace_id, email, role }` (`member` \| `admin` \| `owner`); `create_invite` RPC. |
| POST | `/v1/dashboard/invites/revoke` | S + CSRF | `{ invite_id }`; `revoke_invite` RPC. |
| POST | `/v1/dashboard/members/role` | S + CSRF | `{ workspace_id, user_id, role }`; `update_member_role` RPC. |
| POST | `/v1/dashboard/members/remove` | S + CSRF | `{ workspace_id, user_id }`; `remove_member` RPC. |

### 6.9 Health

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/healthz` | P | Validates critical env, returns `version` + `embedding_model`. |
| GET | `/ready` | P | Circuit-breaker-wrapped `get_api_key_salt` RPC. |
| GET | `/v1/health` | P | Same payload as `/healthz`. |

### 6.10 Admin

All auth with `x-admin-token` (legacy equality or HMAC-signed). If `DISABLE_SERVICE_ROLE_REQUEST_PATH=1`, these routes return `503 CONTROL_PLANE_ONLY`.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/admin/webhooks/reprocess` | Rerun `reconcilePayUWebhook` for deferred events |
| POST | `/admin/usage/reconcile` | `process_usage_reservation_refunds()` RPC |
| POST | `/admin/sessions/cleanup` | Delete expired `dashboard_sessions` |
| POST | `/admin/memory-hygiene` | `find_near_duplicate_memories(...)`; query: `dry_run`, `limit`, `workspace_id` |
| POST | `/admin/memory-retention` | Archive per retention; query: `limit` |
| GET | `/v1/admin/billing/health` | Billing health view |
| GET | `/v1/admin/founder/phase1` | Metrics for internal dashboard |

### 6.11 MCP

- `POST /v1/mcp`, `POST /mcp` → Streamable HTTP JSON-RPC (`handleHostedMcpRequest` in [apps/api/src/mcpHosted.ts](../../apps/api/src/mcpHosted.ts)).
- `GET /v1/mcp`, `GET /mcp` → browser landing or SSE.
- `DELETE /v1/mcp`, `DELETE /mcp` → close session.

See [docs/MCP_SERVER.md](../MCP_SERVER.md) for the tool catalog.

## 7. Canonical flows

### 7.1 `POST /v1/memories`
auth → per-key + per-workspace rate limit (`RATE_LIMIT_DO`) → workspace concurrency lease → `resolveQuotaForWorkspace` → `reserve_usage_if_within_cap` → `checkGlobalCostGuard` → OpenAI embed (circuit-breakered + retry + timeout) → insert `memories` and `memory_chunks` (RLS) → optional `gpt-4o-mini` extraction (up to 10 child memories) → `commit_usage_reservation` → audit.

### 7.2 `POST /v1/search`
auth → rate limit → read reservation → embed query → pgvector search + rerank → optional `search_query_history` insert → response.

### 7.3 `POST /v1/billing/checkout`
Insert `payu_transactions` row → build SHA-512 request hash (`buildPayURequestHashInput`) → return `{url, method:"POST", fields}`. The dashboard auto-submits the form.

### 7.4 `POST /v1/billing/webhook`
Verify reverse SHA-512 (or HMAC-SHA256 fallback) → `verifyPayUTransactionViaApi` with retry and timeout → `upsertWorkspaceEntitlementFromTransaction` → `200`. Idempotent via `payu_webhook_events`.

### 7.5 `POST /v1/webhooks/memory`
HMAC-SHA256 verify against `memory_ingest_webhooks.signing_secret` for the referenced workspace → synthesize trusted internal auth → forward to `POST /v1/memories`.

## 8. Client headers you may see

| Header | Meaning |
| --- | --- |
| `x-request-id` | Correlation id on every response |
| `x-mn-resolved-container-tag` | Resolved tenant container (debug) |
| `x-mn-routing-mode` | `service-role`, `rpc-first`, or `rls-first` (debug) |
| `Retry-After` | Seconds (429 responses) |

## 9. Changes and drift

`docs/external/openapi.yaml` is generated from code by [apps/api/scripts/generate_openapi.mjs](../../apps/api/scripts/generate_openapi.mjs). CI enforces drift with `pnpm openapi:check` and `pnpm check:docs-drift`. See [.cursor/rules/documentation-governance.mdc](../../.cursor/rules/documentation-governance.mdc).
