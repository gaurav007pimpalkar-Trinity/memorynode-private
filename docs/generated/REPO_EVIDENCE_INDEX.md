# MemoryNode.ai – Evidence Index (repo scan)

## Repo Map (2–3 levels)
- Root: `apps/`, `packages/`, `infra/sql/`, `docs/`, `scripts/`, config files (`package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `vitest.config.ts`).
- API (Cloudflare Worker): `apps/api/src/index.ts` main entry; support files `apps/api/src/limits.ts`, `apps/api/src/rateLimitDO.ts`; config `apps/api/wrangler.toml`; env template `.dev.vars.template`; tests `apps/api/tests/*.test.ts`.
- Dashboard (Supabase React): `apps/dashboard/src/` (`App.tsx`, `supabaseClient.ts`, `apiClient.ts`, `state.ts`, `types.ts`, `styles.css`); config `apps/dashboard/vite.config.ts`, `.env.example`; build outputs `apps/dashboard/dist/*`.
- SDK: `packages/sdk/src/index.ts` (exports client), tests `packages/sdk/tests/index.test.ts`.
- Shared types: `packages/shared/src/index.ts`.
- Database migrations: `infra/sql/001_init.sql` … `016_webhook_events.sql`.
- Docs: `docs/README.md`, `QUICKSTART.md`, `API_REFERENCE.md`, `LAUNCH_CHECKLIST.md`.
- Tooling/scripts: `scripts/dev_bootstrap.mjs`, `scripts/smoke.ps1`, `scripts/smoke.sh`, `scripts/e2e_smoke.ps1`, `scripts/e2e_smoke.sh`.

## Components & Responsibilities
- **Cloudflare Worker API**: default export `fetch` router in `apps/api/src/index.ts` (~400–550) dispatches HTTP routes; implements business logic for memories, search/context, usage, billing, admin (workspace/api-key), export/import. Rate limit Durable Object binding `RATE_LIMIT_DO`; error handling, CORS, security headers.
- **RateLimit Durable Object**: `apps/api/src/rateLimitDO.ts` provides per-key windowed counter and headers.
- **Limits & plans**: `apps/api/src/limits.ts` defines caps, body limits, rate window.
- **Stub/runtime helpers**: `createStubSupabase`, `stubEmbedding`, chunking, export/import utilities within `apps/api/src/index.ts` (~520–2200).
- **Dashboard**: `apps/dashboard/src/App.tsx` main UI; uses Supabase auth, RPCs, and Worker API (`apiClient.ts`). Tabs for API key storage, memory search/browser, usage, billing, invites/members.
- **SDK**: `packages/sdk/src/index.ts` exposes `MemoryNodeClient` with methods matching API routes and header handling; defaults base URL 127.0.0.1:8787.
- **Shared contract**: `packages/shared/src/index.ts` defines TS interfaces for requests/responses used by SDK & API.
- **Migrations/DB layer**: SQL files define schema, RPCs, RLS, billing, events, invites, webhook storage. Worker calls Supabase RPCs (`match_chunks_vector/text`, `bump_usage`, `create_workspace`, `create_api_key`, etc.).

## API Endpoints & Handler Locations
- `GET /healthz` → inline in router `fetch` (`apps/api/src/index.ts` ~430–438).
- `POST /v1/memories` → `handleCreateMemory` (`index.ts` ~830–930); chunking, embedding, insert memories & memory_chunks, emits product event.
- `GET /v1/memories` → `handleListMemories` (`index.ts` ~955–987); pagination/filter parsing.
- `GET /v1/memories/:id` → `handleGetMemory` (`index.ts` ~988–1021).
- `DELETE /v1/memories/:id` → `handleDeleteMemory` (`index.ts` ~1027–1050).
- `POST /v1/search` → `handleSearch` (`index.ts` ~1052–1110); embeds query, calls RPCs `match_chunks_vector/text`, reciprocal-rank fusion.
- `POST /v1/context` → `handleContext` (`index.ts` ~1113–1175); reuses search results, builds concatenated context with citations, deduped.
- `GET /v1/usage/today` → `handleUsageToday` (`index.ts` ~2634–2664); authenticates key, rate limits, returns usage + caps.
- **Billing**: `GET /v1/billing/status` (`index.ts` ~2667–2726); `POST /v1/billing/checkout` (~2729–2798); `POST /v1/billing/portal` (~2801–2866); `POST /v1/billing/webhook` (~2869–2977). Stripe env validation via `missingStripeEnv` (`index.ts` ~180–214) & client `getStripeClient` (~214–230).
- **Admin (x-admin-token)**: `POST /v1/workspaces` → `handleCreateWorkspace` (`index.ts` ~2365–2414); `POST /v1/api-keys` → `handleCreateApiKey` (~2417–2467); `GET /v1/api-keys` → `handleListApiKeys` (~2470–2508); `POST /v1/api-keys/revoke` → `handleRevokeApiKey` (~2511–2547).
- **Export/Import**: `POST /v1/export` → `handleExport` (`index.ts` ~2585–2599) calling `exportArtifact` (~1540–1608); `POST /v1/import` → `handleImport` (~2606–2631) calling `importArtifact` (~1608–1695); ZIP negotiation via `wantsZipResponse` (~1629–1637).
- **Rate limit service**: Durable Object binding required; `ensureRateLimitDo` (`index.ts` ~360–371) fails fast without binding.
- **Body limits & security headers**: `resolveBodyLimit` (`index.ts` ~373–392); `buildSecurityHeaders` (`index.ts` ~399–417) with CORS in `makeCorsHeaders` (earlier in file).

## Storage Layer (DB) Evidence
- Tables defined in `infra/sql/001_init.sql`: `workspaces`, `api_keys` (hashed), `memories`, `memory_chunks` (vector(1536) + `tsv`), `usage_daily`; indexes for vector/tsv and workspace/user/namespace.
- RPC search functions `match_chunks_vector` & `match_chunks_text` in `infra/sql/002_rpc.sql`; used in `callMatchVector`/`callMatchText` (`index.ts` ~1905–1950).
- Usage bump RPC `bump_usage` in `infra/sql/003_usage_rpc.sql`; used in `bumpUsage` (`index.ts` ~2230–2255) and caps checks.
- Plan column added in `infra/sql/004_workspace_plan.sql`; plan_status/billing fields added in `infra/sql/012_billing.sql`.
- RLS baseline `infra/sql/006_rls.sql` and membership-based RLS `infra/sql/008_membership_rls.sql`.
- API audit log table `infra/sql/005_api_audit_log.sql`; Worker writes via `emitAuditLog` block (`index.ts` ~1410–1478).
- Workspace RPCs `create_workspace` in `infra/sql/009_workspace_rpc.sql`; API key RPCs `create_api_key`, `list_api_keys`, `revoke_api_key`, `get_api_key_salt` in `infra/sql/011_api_key_rpcs.sql`.
- Events table `infra/sql/013_events.sql` used by `emitProductEvent` (`index.ts` ~70–120, 239–260).
- Activation metrics RPC `infra/sql/014_activation.sql`; invites/membership management `infra/sql/015_invites.sql`; webhook event storage `infra/sql/016_webhook_events.sql`.

## Runtime Flows (traced)
- **Ingest/write**: Router → `handleCreateMemory` (`index.ts` ~830) → `authenticate` (api key) → `rateLimit` (Durable Object) → body parse/validation (MAX_TEXT_CHARS) → `chunkText` (paragraph-aware, overlap) (`index.ts` ~1760) → `embedText` (OpenAI or stub) (`index.ts` ~1840–1895 & ~2160 stub) → insert `memories` then `memory_chunks` with embeddings → `bumpUsage` writes/embeds; emits product event `first_ingest_success`.
- **Search/retrieval**: `handleSearch` (`index.ts` ~1052) → `authenticate` + rate limit → `normalizeSearchPayload` (validates metadata/time filters) (`index.ts` ~1215–1310) → embed query → `callMatchVector`/`callMatchText` RPCs → `reciprocalRankFusion` (`index.ts` ~1960–1995) → `dedupeFusionResults` and `finalizeResults` (`index.ts` ~1997–2055) → `bumpUsage` reads+embeds.
- **Context assembly**: `handleContext` (`index.ts` ~1113) shares search pipeline, then builds `context_text` and citations array (`buildContextResponse` inline around ~1178–1205), deduped, paginated; emits `first_context_success`.
- **Export/Import**: `exportArtifact` (`index.ts` ~1540) gathers workspace memories/chunks (Supabase selects), builds NDJSON files, manifest v1 (workspace_id, counts, sha256), ZIP via JSZip with deterministic timestamps; `wantsZipResponse` negotiates zip vs JSON; `importArtifact` (`index.ts` ~1608) validates manifest workspace/version/sha, size limits, supports modes (`upsert`, `skip_existing`, `error_on_conflict`, `replace_ids`, `replace_all`) and writes to `memories` / `memory_chunks`.

## Security Controls Implemented
- **Auth**: API key auth in `authenticate` (`index.ts` ~1185–1235) with hash using `API_KEY_SALT` from env or `app_settings`; stub path for `SUPABASE_MODE=stub`.
- **Admin plane**: `requireAdmin` (`index.ts` ~2330) checks `x-admin-token` for admin endpoints.
- **Rate limiting**: Per-key via Durable Object (`rateLimit` `index.ts` ~2295–2317) returning standard rate headers; enforced on all routes (search, context, memories, usage, billing, admin).
- **Usage caps**: `checkCapsAndMaybeRespond` (`index.ts` ~298–333) uses plan caps from `limits.ts`; applied to ingest/search/context.
- **RLS/tenancy**: Database policies in `infra/sql/006_rls.sql` and `008_membership_rls.sql`; Worker relies on Supabase JWT role/uid + workspace membership RPCs.
- **CORS/Security headers**: `makeCorsHeaders` and `buildSecurityHeaders` (`index.ts` ~399) with allowlist env `ALLOWED_ORIGINS`; `resolveBodyLimit` route-specific sizes.
- **Redaction/log hygiene**: `redact` helper (`index.ts` ~1497) masks secrets; `emitAuditLog` writes hashed IP with salt `AUDIT_IP_SALT` (`index.ts` ~1410–1478).
- **Billing safety**: `missingStripeEnv` and `getStripeClient` (`index.ts` ~180–230) guard prod env; webhook signature validation in `handleBillingWebhook` (`index.ts` ~2870+).

## SDK Exported APIs (packages/sdk/src/index.ts)
- `MemoryNodeClient` constructor options `{ baseUrl?, apiKey? }`.
- Methods:
  - `createWorkspace(name, adminToken)`; `createApiKey(workspaceId, name, adminToken)`; `listApiKeys(workspaceId, adminToken)`; `revokeApiKey(apiKeyId, adminToken)`.
  - `health()` → GET `/healthz`.
  - `getUsageToday()` → GET `/v1/usage/today`.
  - `addMemory({ userId, namespace?, text, metadata? })` → POST `/v1/memories`.
  - `search(options)` / `context(options)` → POST `/v1/search|context` (filters, pagination).
  - `listMemories(options)` → GET `/v1/memories` with query params.
  - `getMemory(id)`, `deleteMemory(id)` → GET/DELETE `/v1/memories/:id`.
  - `exportMemories()` (JSON) / `exportMemoriesZip()` (binary) → POST `/v1/export`.
  - `importMemories(artifactBase64, mode?)` → POST `/v1/import`.
- Shared request/response types defined in `packages/shared/src/index.ts` (AddMemoryRequest/Response, Search/Context responses, MemoryRecord, Export/Import, UsageToday, API key/workspace/billing types).

## Dashboard Key Interfaces (apps/dashboard/src/App.tsx)
- Uses Supabase auth (`supabaseClient.ts`) and RPCs (`create_workspace`, `list_api_keys`, `create_api_key`, `revoke_api_key`, `activation_counts`, `create_invite`, `revoke_invite`, `update_member_role`, `remove_member`) seen via calls in `App.tsx` (~230–950).
- Worker API usage: `apiClient.ts` wraps fetch to `/v1/usage/today`, `/v1/search`, `/v1/memories/:id` with API key header set in UI (`App.tsx` tabs MemoryView/UsageView).
- Billing buttons call Worker endpoints `/v1/billing/status|checkout|portal` (App.tsx ~720–820).

## Scripts / Tooling
- `scripts/dev_bootstrap.mjs`: creates workspace + API key via admin endpoints for local dev.
- `scripts/smoke.ps1` / `scripts/smoke.sh`: run wrangler dev, health check, create workspace/api-key, ingest, search, context; uses stub embeddings; logs to `.tmp/wrangler.log`.
- `scripts/e2e_smoke.ps1` / `scripts/e2e_smoke.sh`: e2e smoke using env `.env.e2e`; exercises /healthz, memories, search, context, usage.
- NPM scripts (`package.json` root): `dev`, `dev:api`, `lint`, `typecheck`, `test`, `smoke`, `smoke:ps`, `smoke:ci`.
- API package scripts: `apps/api/package.json` → `dev` (`wrangler dev`), `build` (`wrangler publish --dry-run`).
- Dashboard scripts: `apps/dashboard/package.json` → `dev|build|preview|typecheck`.

## “Unknown from repo scan”
- External deployment specifics (Cloudflare env bindings/ids beyond `wrangler.toml`) not present.
- Production monitoring/export destinations for logs/metrics not defined; only in-code logging.

