# MemoryNode API Reference (v1)

Base URL (dev): `http://127.0.0.1:8787`

Auth:
- Worker API: `Authorization: Bearer <api_key>` or `x-api-key`.
- Admin control plane: `x-admin-token: <MASTER_ADMIN_TOKEN>` (workspace/api-key management).

Health
- `GET /healthz` → `{ status: "ok", version, build_version, embedding_model, stage?, git_sha? }`
  - `embedding_model`: `text-embedding-3-small` (OpenAI) or `stub` (dev)

Response headers:
- Every response includes `x-request-id`.

Error shape:
- `{ error: { code, message }, request_id }`

Memories
- `POST /v1/memories` – ingest memory  
  Body: `{ user_id, text, namespace?, metadata? }`  
  Returns: `{ memory_id, chunks }`
- `GET /v1/memories` – list with pagination/filters  
  Query: `page`, `page_size`, `namespace`, `user_id`, `metadata` (JSON), `start_time`, `end_time`
- `GET /v1/memories/:id` – fetch one
- `DELETE /v1/memories/:id` – delete

Retrieval
- `POST /v1/search` – hybrid search (vector + full-text + RRF)  
  Body: `{ user_id, query, namespace?, top_k?, page?, page_size?, explain?, filters? }`  
  With `explain: true`, each result includes `_explain: { rrf_score, match_sources, vector_score?, text_score? }`  
  Header `X-Save-History: true` saves query+results for replay
- `GET /v1/search/history` – list saved queries (query, params, created_at)
- `POST /v1/search/replay` – re-run a saved query; returns `{ previous, current }` for comparison  
  Body: `{ query_id }`
- `POST /v1/context` – prompt-ready context + citations  
  Body: same as search  
  Returns: `{ context_text, citations:[{i,chunk_id,memory_id,chunk_index}], page, total, has_more }`

Usage & Limits
- `GET /v1/usage/today` – usage counters and effective plan caps.

Export / Import
- `POST /v1/export` – returns `{ artifact_base64, bytes, sha256 }` or ZIP when `Accept: application/zip` or `?format=zip`.
- `POST /v1/import` – restore from export. Body: `{ artifact_base64, mode? }` (`upsert|skip_existing|error_on_conflict|replace_ids|replace_all`).

Admin (control plane)
- `POST /v1/workspaces` – create workspace (admin token required).
- `POST /v1/api-keys` – create API key for workspace.
- `GET /v1/api-keys?workspace_id=...` – list masked keys (includes `created_at`, `revoked_at`, `last_used_at`, `last_used_ip` when available).
- `POST /v1/api-keys/revoke` – revoke API key (body: `{ api_key_id }`).
- **Rotation:** Create a new key via `POST /v1/api-keys`, then revoke the old key via `POST /v1/api-keys/revoke` after a grace period (e.g. 24 h) so clients can switch. “If you lose your key, you rotate” — no key recovery; rotation is the supported path.

Billing
- `GET /v1/billing/status` – Returns `plan`, `plan_status`, `effective_plan`, `current_period_end`, `cancel_at_period_end`. Use **effective_plan** for display and quotas; `plan` is legacy DB (free/pro).
- `POST /v1/billing/checkout` – Body `{ plan?: "launch"|"build"|"deploy"|"scale"|"scale_plus" }`, returns PayU hosted checkout (URL or POST form fields).
- `POST /v1/billing/portal` – returns `410 Gone` (legacy Stripe portal removed; PayU billing is platform-only via checkout/webhooks).
- `POST /v1/billing/webhook` – PayU callback (raw body, hash verified with PAYU_MERCHANT_SALT/PAYU_MERCHANT_KEY).

Plans & Limits
- See Plans & Limits in docs (e.g. docs/internal/README.md § Plans & Limits). Plans: Launch ₹299/7d, Build ₹499/month, Deploy ₹1,999/month, Scale ₹4,999/month, Scale+ custom. Limits: writes/day, reads/day, embed_tokens/day (hard gate). Rate limit: 60 req/min (15 for new keys first 48h).
- **Plan codes (internal vs external):** The DB `workspaces` table and legacy fields use `plan` values `free` / `pro` / `team` for compatibility. The **external contract** for quotas and display is **effective_plan** (e.g. `launch`, `build`, `deploy`, `scale`, `scale_plus`). Billing and entitlements resolve to these; always use `effective_plan` from API responses for limits and UI.

Retrieval quality (Phase 5)
- `GET /v1/eval/sets` – list eval sets
- `POST /v1/eval/sets` – create eval set. Body: `{ name }`
- `POST /v1/eval/sets/:id/items` – add eval item. Body: `{ query, expected_memory_ids: uuid[] }`
- `POST /v1/eval/run` – run evaluation. Body: `{ eval_set_id, user_id, namespace? }`  
  Returns `{ items, summary: { avg_precision_at_k, avg_recall } }`

Dashboard/Supabase RPCs (workspace auth)
- `create_workspace`, `create_api_key`, `list_api_keys`, `revoke_api_key`
- Invites & roles: `create_invite`, `revoke_invite`, `accept_invite`, `update_member_role`, `remove_member`

SDK
- `addMemory`, `search`, `context`, `listMemories`, `getMemory`, `deleteMemory`, `exportMemories`, `importMemories`, `getUsageToday`, `createWorkspace`, `createApiKey`, `listApiKeys`, `revokeApiKey`.

Machine-readable spec
- OpenAPI 3.0: `docs/external/openapi.yaml` (generated from Zod schemas in `apps/api/src/contracts/`).
- To regenerate: `pnpm openapi:gen`. CI runs `pnpm openapi:check` to prevent drift.

See `docs/external/QUICKSTART.md` for setup and `docs/RELEASE_RUNBOOK.md` for deployment steps.

---

## Retrieval cockpit — end-to-end demo (merged from RETRIEVAL_COCKPIT_DEMO.md)

Phase 5: eval sets, replayable queries, explainability, embedding visibility.

**1. Embedding model visibility:** `curl http://127.0.0.1:8787/healthz` — response includes `embedding_model`: `text-embedding-3-small` (OpenAI) or `stub` (local dev).

**2. Explainability (“why this result”):** Add `explain: true` to search. Each result includes `_explain`: `rrf_score`, `match_sources` (["vector"], ["text"], or ["vector","text"]), `vector_score` (cosine 0–1), `text_score` (ts_rank), `rrf_score` (RRF combined).

**3. Replayable queries:** Save: `POST /v1/search` with header `X-Save-History: true`. List: `GET /v1/search/history?limit=10`. Replay: `POST /v1/search/replay` body `{ "query_id": "<uuid-from-history>" }` — returns `{ previous, current }` to compare after adding memories or tuning.

**4. Evaluation sets:** Create: `POST /v1/eval/sets` body `{ "name": "smoke-eval" }`. Add items: `POST /v1/eval/sets/$EVAL_SET_ID/items` body `{ "query": "...", "expected_memory_ids": ["mem-uuid-1", ...] }`. Run: `POST /v1/eval/run` body `{ "eval_set_id", "user_id", "namespace?" }` — returns `items` with precision_at_k, recall, and `summary.avg_precision_at_k`, `avg_recall`.

**5. End-to-end flow:** Ingest memories (QUICKSTART §7) → search with `explain: true` → save with `X-Save-History: true` → add more memories → replay and compare previous vs current → create eval set, add items, run eval → iterate on chunking/embeddings/filters.
