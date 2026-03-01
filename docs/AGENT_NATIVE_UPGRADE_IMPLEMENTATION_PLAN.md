# Agent-Native Memory SDK Upgrade — Implementation Plan

**Scope:** 2026 Builder/Agent SDK edition. Three upgrades only: Episodic Event Store, Recency Weight Decay, MCP Integration.  
**Out of scope:** Local-first, storage_tier/sync_status, compliance, knowledge graph, summarization pipeline, compression engine.

---

## Phased execution order

| Phase | Upgrade | Rationale |
|-------|--------|-----------|
| **1** | Episodic Agent Event Store | Standalone; no dependency on decay or MCP. Gives agents a place to log tool/agent events. |
| **2** | Recency Weight Decay | Self-contained (migration + RPC + Worker). Search API contract unchanged. |
| **3** | MCP Integration | Wraps existing REST (search + episodes); implement last so surface is stable. |

---

## Phase 1: Episodic Agent Event Store

### 1.1 New files

| File | Purpose |
|------|--------|
| `infra/sql/028_agent_episodes.sql` | Table `agent_episodes` + index + RLS. |
| `apps/api/src/contracts/episodes.ts` | Zod schemas: `EpisodeInsertSchema`, `EpisodeEventType`, list params. |
| `apps/api/src/handlers/episodes.ts` | `createEpisodeHandlers()` → `handleCreateEpisode`, `handleListEpisodes`. |

### 1.2 Existing files to modify

| File | Change |
|------|--------|
| `apps/api/src/contracts/index.ts` | Export episode schemas/types. |
| `apps/api/src/router.ts` | Add `handleCreateEpisode`, `handleListEpisodes` to `RouterHandlers`; add `POST /v1/episodes`, `GET /v1/episodes` in `route()`. |
| `apps/api/src/workerApp.ts` | Export nothing new (handlers call Supabase directly). Optional: add `performListEpisodes` if you want search-style caps/audit; for minimal scope, handlers can use Supabase + auth only. |
| `apps/api/src/index.ts` | Import and pass `handleCreateEpisode`, `handleListEpisodes` into router deps. |
| `packages/shared/src/index.ts` | Add `EpisodeEventType`, `EpisodeRecord`, `ListEpisodesResponse` (optional; or keep API-only and have MCP/SDK use raw JSON). |

### 1.3 SQL migration: `028_agent_episodes.sql`

- **Schema:** Explicit primary key `id uuid primary key default gen_random_uuid()`. Add `metadata jsonb default '{}'::jsonb`. Index `(workspace_id, session_id, created_at desc)`. RLS enforces workspace isolation (service_role or `workspace_id = current_workspace()`). No analytics, no aggregation, no enterprise extensions.

```sql
-- Agent/tool event log for temporal recall. No analytics; minimal schema.
create table if not exists agent_episodes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text,
  session_id text not null,
  event_type text not null check (event_type in ('tool_call', 'tool_result', 'agent_step', 'observation')),
  tool_name text,
  input_summary text,
  output_summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_episodes_workspace_session_created_idx
  on agent_episodes (workspace_id, session_id, created_at desc);

-- RLS: workspace isolation
alter table agent_episodes enable row level security;
create policy agent_episodes_sel on agent_episodes for select
  using (auth.role() = 'service_role' or workspace_id = current_workspace());
create policy agent_episodes_ins on agent_episodes for insert
  with check (auth.role() = 'service_role' or workspace_id = current_workspace());
```

- **Note:** Handler must set `workspace_id` from auth on insert and filter by `workspace_id` on list.

### 1.4 API surface

- **POST /v1/episodes**  
  - Body: `{ session_id, event_type, tool_name?, input_summary?, output_summary?, user_id? }`.  
  - Auth: existing Bearer API key → `workspace_id` from auth.  
  - Response: `201` + `{ id, created_at }`.

- **GET /v1/episodes**  
  - Query: `session_id` (required), `start_time`, `end_time` (ISO), `limit` (default 50, max 200).  
  - Response: `200` + `{ results: [...], has_more }`.

### 1.5 Order of implementation

1. Add `028_agent_episodes.sql` and run migrations.
2. Add `contracts/episodes.ts` (Zod + types) and export from `contracts/index.ts`.
3. Add `handlers/episodes.ts`: authenticate, parse body/query, insert/select from `agent_episodes`, return JSON.
4. Extend `router.ts` and `index.ts` to wire handlers.
5. (Optional) Add shared types in `packages/shared` for SDK/MCP.

### 1.6 Risk areas

- **RLS:** Table uses `current_workspace()`; API uses service_role so RLS allows. Handler must set `workspace_id` from auth on insert and filter by `workspace_id` on list so tenants only see their own data.
- **Index:** Single index `(workspace_id, session_id, created_at desc)` is enough for “list by session + time” and keeps writes cheap.

---

## Phase 2: Recency Weight Decay

### 2.1 New files

| File | Purpose |
|------|--------|
| `infra/sql/029_decay_ranking.sql` | Add `last_accessed_at`, `access_count` to `memory_chunks`; replace `match_chunks_vector` and `match_chunks_text` with decay-aware versions. |

### 2.2 Existing files to modify

| File | Change |
|------|--------|
| `apps/api/src/workerApp.ts` | Add `bumpChunkAccess(supabase, workspaceId, chunkIds)`. Call it from `performSearch` after final results **fire-and-forget (do NOT await)**. Non-blocking only. |

### 2.3 SQL migration: `029_decay_ranking.sql`

- **Columns on `memory_chunks`:** `last_accessed_at timestamptz default null`, `access_count int not null default 0`.
- **NULL-safe access time:** Use `COALESCE(last_accessed_at, created_at)` for decay.
- **Decay formula (half-life):** `exp(-ln(2) * days_since_access / 30)` (30-day half-life). `days_since_access = extract(epoch from (now() - COALESCE(mc.last_accessed_at, mc.created_at)))/86400.0`. `boost = 1 + 0.1 * ln(1 + coalesce(mc.access_count, 0))` (cap optional). `score = raw_score * decay * boost`.
- **RPCs:** Replace `match_chunks_vector` and `match_chunks_text` with decay-aware versions; same signature. Do not change API surface; ranking remains internal.
- **Lightweight only.** No summarization, no compression, no archival system.

### 2.4 API surface

- No new endpoints. Search and context responses unchanged; ranking is internal.

### 2.5 Order of implementation

1. Add `029_decay_ranking.sql` (alter table + replace both RPCs with NULL-safe decay: `COALESCE(last_accessed_at, created_at)`, half-life `exp(-ln(2) * days_since_access / 30)`).
2. In `workerApp.ts`, add `bumpChunkAccess(supabase, workspaceId, chunkIds)` and call it from `performSearch` after `finalizeResults` **fire-and-forget (do NOT await)**.
3. Run migrations and run search tests.

### 2.6 Risk areas

- **Performance:** UPDATE by chunk ids can be a batch of 10–100 rows per search; keep it single statement and non-blocking (fire-and-forget or catch and log) so latency is unaffected.
- **RPC correctness:** Ensure 027’s filters (duplicate_of, memory_type, metadata, time) remain unchanged; only the score expression changes.
- **Decay constants:** Use env or constants (e.g. `DECAY_LAMBDA`, `DECAY_BOOST_ALPHA`) later if needed; for MVP hardcode in SQL.

---

## Phase 3: MCP Integration

### 3.1 New files

| File | Purpose |
|------|--------|
| `packages/mcp-server/package.json` | New workspace package: `@memorynodeai/mcp-server`, dependency `@modelcontextprotocol/sdk`, `zod`. |
| `packages/mcp-server/tsconfig.json` | Target ES2022, module NodeNext. |
| `packages/mcp-server/src/index.ts` | MCP server (stdio): register tool `memory_search`, register resource `memory://search` with URI pattern; both call existing REST API. |
| `docs/MCP_SERVER.md` | How to run the server, set `MEMORYNODE_API_KEY` and `MEMORYNODE_BASE_URL`, and attach to Cursor/Claude. |

### 3.2 Existing files to modify

| File | Change |
|------|--------|
| Root `package.json` or `pnpm-workspace.yaml` | Add `packages/mcp-server` to workspace if not auto-discovered. |
| None in `apps/api` | MCP server is a separate process; no changes to Worker. |

### 3.3 MCP server behavior (minimal)

- **MCP must call existing REST API only.** MUST NOT access Supabase directly. Map REST errors to proper MCP errors.
- **Auth:** `MEMORYNODE_API_KEY`, `MEMORYNODE_BASE_URL`. No additional auth layer.
- **Tool `memory_search`:** Input: `query`, `user_id`, `namespace?`, `top_k?`. Handler: `fetch(MEMORYNODE_BASE_URL + "/v1/search", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey }, body: JSON.stringify({ user_id, query, namespace, top_k }) })`. Return tool result; on 4xx/5xx map to MCP error.
- **Resource `memory://search?q=...`:** `readResource`: parse URI, call same `/v1/search`, return text/JSON of results. Map REST errors to MCP errors.
- Keep minimal: only tool `memory_search` and resource `memory://search?q=...`.

### 3.4 API surface

- No new REST endpoints. MCP server uses existing `POST /v1/search` and, if desired, `GET /v1/episodes` (optional later).

### 3.5 Order of implementation

1. Create `packages/mcp-server` with package.json, tsconfig, and `src/index.ts` using `@modelcontextprotocol/sdk` (stdio server).
2. Implement tool `memory_search` and resource `memory://search`.
3. Add `docs/MCP_SERVER.md` with run instructions and env vars.
4. Add package to workspace and run from repo root: `pnpm --filter @memorynodeai/mcp-server build` (or `tsx src/index.ts` for dev).

### 3.6 Risk areas

- **API key handling:** Server must not log or expose the key; read from env only.
- **Stdio vs HTTP transport:** MVP uses stdio; Cursor/Claude connect to the server process. No need for HTTP MCP transport in this phase.
- **Errors:** Map API errors (4xx/5xx) to MCP error response so the client sees a clear message.

---

## Summary: file and migration checklist

| Phase | New files | Modified files | Migrations |
|-------|-----------|----------------|------------|
| 1 Episodic | `infra/sql/028_agent_episodes.sql`, `contracts/episodes.ts`, `handlers/episodes.ts` | `contracts/index.ts`, `router.ts`, `index.ts` | 028 |
| 2 Decay | `infra/sql/029_decay_ranking.sql` | `workerApp.ts` | 029 |
| 3 MCP | `packages/mcp-server/package.json`, `tsconfig.json`, `src/index.ts`, `docs/MCP_SERVER.md` | Workspace config | — |

---

## Testing (minimal)

- **Phase 1:** Integration test: POST episode, GET episodes by session_id and time range; assert 201 and 200 with expected shape.
- **Phase 2:** Search test: run search, then run same search again; optionally assert that returned order or scores differ (or that `access_count`/`last_accessed_at` updated in DB). Existing search tests should still pass.
- **Phase 3:** Manual: run MCP server with env set, use Cursor/Claude to call `memory_search` and read `memory://search?q=...`; confirm results match REST API.

No new enterprise or long-term roadmap; this plan is scoped to ship the 2026 Agent-Native MVP.
