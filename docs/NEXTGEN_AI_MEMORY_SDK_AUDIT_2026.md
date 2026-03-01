# Next-Gen AI Memory SDK Audit (2026 Standards)

**Scope:** Tiered Memory pillars for an Agentic / MCP-ready Memory SDK.  
**Codebase:** MemoryNode.ai (API Worker, Supabase, SDK, shared contracts).  
**Date:** 2026-03-01.

---

## 1. Gap Analysis Table

| Feature | Status | Missing Logic |
|--------|--------|----------------|
| **Episodic Memory** | **Partial** | No dedicated agent/tool event store; only request audit, product events, and search query history. Time filters on search exist; no first-class "episode" type or tool-output persistence. |
| **Semantic Memory** | **Present** | Vector store (embeddings), hybrid search, fact/preference/event extraction and typing. Minor gap: no explicit "knowledge graph facts" API surface beyond `memory_type`. |
| **Procedural/Graph Memory** | **Partial** | Only duplicate/source links (`duplicate_of`, `source_memory_id`). No entity-relationship model, no "User A works for Company B" style relations or graph queries. |
| **MCP Integration** | **Absent** | No MCP server, no `readResource` / `callTool` for memory. SDK is REST-only; no protocol adapter for external agents. |
| **Memory Hygiene** | **Partial** | Duplicate detection + marking; relevance scoring (RRF, `min_score`). No summarization, compression, or weight decay / time-based forgetting. |
| **Privacy/Edge Logic** | **Partial** | Edge (Cloudflare) + central (Supabase) in docs; hashed audit/IP. No local vs cloud split, no `sync_status` / `last_synced_at`, no "sensitive vs synced" or local-first storage model. |

---

## 2. Feature-by-Feature: Presence and Code References

### 2.1 Episodic Memory (timestamped event logs, agent actions, tool outputs)

**Present:**

- **Request audit (timestamped):**  
  - `infra/sql/005_api_audit_log.sql`: table `api_audit_log` — `route`, `method`, `status`, `bytes_in`, `bytes_out`, `latency_ms`, `ip_hash`, `user_agent`, `created_at`; indexes on `route`, `created_at desc`.  
  - `apps/api/src/audit.ts`: `emitAuditLog(...)` inserts into `api_audit_log`.
- **Product/activation events:**  
  - `infra/sql/013_events.sql`: table `product_events` — `created_at`, `workspace_id`, `event_name`, `request_id`, `route`, `method`, `status`, `effective_plan`, `plan_status`, `props` (jsonb).
- **Search query history (query-level “episodes”):**  
  - `infra/sql/026_retrieval_cockpit.sql`: table `search_query_history` — `query`, `params`, `results_snapshot`, `created_at`; index `(workspace_id, created_at desc)`.  
  - `apps/api/src/handlers/search.ts`: list/replay handlers use `search_query_history`.
- **Temporal filters on memory search:**  
  - `infra/sql/002_rpc.sql`, `infra/sql/027_smart_memory_upgrade.sql`: RPCs `match_chunks_vector` and `match_chunks_text` accept `p_start_time`, `p_end_time` (timestamptz); filter `mc.created_at`.  
  - `apps/api/src/workerApp.ts`: `parseIsoTimestamp()` (~2029); `start_time` / `end_time` from payload/query (~2067–2068, 2125–2126, 2630–2631, 2679–2680, 2842–2843, 2922–2923).  
  - `apps/api/src/contracts/search.ts`: `filters.start_time`, `filters.end_time` (lines 20–21).  
  - `packages/sdk/src/index.ts`: `SearchOptions.startTime`, `endTime`; `ListMemoriesOptions.startTime`, `endTime`.

**Missing (where to inject):**

- No table or type for **agent actions** or **tool outputs** (e.g. `agent_events` with `session_id`, `tool_name`, `input_hash`, `output_summary`, `created_at`).  
- **Injection points:** new migration (e.g. `infra/sql/028_agent_episodes.sql`), new handler in `apps/api/src/handlers/` (e.g. `episodes.ts`), and optional ingestion from MCP tool-call hooks later.

---

### 2.2 Semantic Memory (vector knowledge store, facts, preferences)

**Present:**

- **Schema:**  
  - `infra/sql/001_init.sql`: `memory_chunks.embedding vector(1536)`, IVFFlat index `memory_chunks_embedding_idx` (cosine, lists=100); `memory_chunks.tsv` (tsvector) for full-text.
- **Embeddings and search:**  
  - `apps/api/src/workerApp.ts`: `embedText()`, `vectorToPgvectorString()`, `callMatchVector()` → RPC `match_chunks_vector`; `performSearch()` with RRF fusion; `search_mode`: `hybrid` | `vector` | `keyword`.  
  - `apps/api/src/handlers/memories.ts`: embeddings used when creating/updating chunks; `embedText` / `vectorToPgvectorString` referenced for writes.
- **Facts / preferences / events (extraction and typing):**  
  - `apps/api/src/handlers/memories.ts`: `EXTRACTION_PROMPT` (lines ~95–105) — “extract distinct facts, preferences, and events”; `memory_type`: `"fact" | "preference" | "event"`; `ExtractedItem`, `extractItems(text, env)`, `extractAndStore()`.  
  - `infra/sql/027_smart_memory_upgrade.sql`: `memories.memory_type`, `memories.source_memory_id`; RPCs filter by `p_memory_types`.  
  - `apps/api/src/contracts/search.ts`: `MEMORY_TYPES`, `memory_type` in filters (lines 8–9, 23).  
  - `packages/sdk/src/index.ts`: `SearchOptions.memoryType`, `ListMemoriesOptions.memoryType`.

**Missing (optional):**

- Explicit “knowledge fact” API (e.g. structured subject–predicate–object) is not required for MVP; current `memory_type` + metadata covers most use cases. Can add later as a thin layer on top of existing memories.

---

### 2.3 Procedural/Graph Memory (relationship mapping beyond vector similarity)

**Present (duplicate/source graph only):**

- `infra/sql/027_smart_memory_upgrade.sql`:  
  - `memories.duplicate_of` (FK to `memories(id)`), `memories.source_memory_id` (FK); comments and indexes `memories_source_memory_idx`, `memories_memory_type_idx`.  
  - `find_near_duplicate_memories(p_workspace_id, p_similarity_threshold, p_limit)` returns pairs by chunk embedding similarity.  
  - RPCs exclude `m.duplicate_of is null` from search.

**Missing (where to inject):**

- No generic **entity-relationship** or **knowledge graph** (e.g. “User A works for Company B”).  
- **Injection points:**  
  - New table e.g. `memory_relations(workspace_id, subject_memory_id, object_memory_id, relation_type, created_at)` or `entity_relations(subject_id, object_id, relation_type, ...)`.  
  - New RPC or API: e.g. `GET /v1/memories/:id/relations` or graph query endpoint.  
  - Optional: extend extraction in `memories.ts` to emit relation triples and persist to the new store.

---

### 2.4 MCP Integration (readResource / callTool for memory)

**Absent:**

- No `mcp/` directory; no references to `readResource`, `callTool`, or “MCP” in the repo.  
- SDK is REST-only: `packages/sdk/src/index.ts` — `MemoryNodeClient` with `addMemory`, `search`, `context`, `listMemories`, etc., all over HTTP.

**Injection points:**

- Add MCP server (e.g. under `apps/mcp/` or `packages/mcp-server/`) that:  
  - Exposes **resources** such as `memory://workspace/{id}/search?q=...` or `memory://workspace/{id}/context` (mapping to existing `/v1/search`, `/v1/context`).  
  - Exposes **tools** e.g. `memory_search`, `memory_add`, `memory_list` (wrapping existing API with API key from MCP config).  
- Implement MCP `readResource` for at least one memory resource URI scheme.  
- Implement MCP `callTool` for at least `memory_search` (and optionally `memory_add`, `get_context`).  
- Document how agents obtain API key (env, MCP config, or secure broker).

---

### 2.5 Memory Hygiene (summarization, compression, weight decay)

**Present:**

- **Duplicate detection and marking:**  
  - `apps/api/src/handlers/admin.ts`: `handleMemoryHygiene` (lines ~322–427); calls `find_near_duplicate_memories`, sets `duplicate_of` on duplicate.  
  - `apps/api/src/router.ts`: POST `/admin/memory-hygiene` (lines 327–328).  
  - `.github/workflows/memory-hygiene.yml`: weekly dry-run.  
  - `docs/OPERATIONS.md`: memory-hygiene usage.
- **Relevance scoring:**  
  - `apps/api/src/workerApp.ts`: RRF fusion (e.g. RRF_K ~2717), `min_score` filter (e.g. ~2079–2093, 2879–2883); `vector_score`, `text_score`, `rrf_score` in results.  
  - `apps/api/src/contracts/search.ts`: `min_score` (0–1), “ranking-derived score” (line 39).  
  - `packages/sdk/src/index.ts`: `SearchOptions.minScore`.

**Missing (where to inject):**

- **Summarization:** No roll-up of many chunks into a summary memory; no “summarize recent N memories” job.  
  - Injection: new admin handler or cron job; optional `memories.summary_text` or separate `memory_summaries` table; call LLM in batches.
- **Compression:** No merging of overlapping or redundant memories into a single compressed memory.  
  - Injection: extend hygiene job or add a “compress” step after duplicate marking (e.g. merge text, re-embed, single memory).
- **Weight decay / forgetting:** No time-based or recency-based decay; no automatic demotion or archival of old/low-utility memories.  
  - Injection: `memory_chunks` or `memories` could get `last_accessed_at` / `access_count`; RPC or job applies decay to scores or marks “archived”; or soft-delete after TTL. New migration + optional config (e.g. `RETENTION_DAYS`, `DECAY_HALFLIFE_DAYS`).

---

### 2.6 Privacy/Edge Logic (local vs cloud, sensitive vs synced)

**Present (conceptual/infra only):**

- Docs describe Worker as “edge” (Cloudflare) with central Supabase/OpenAI (`docs/MEMORYNODE_BRUTAL_TECHNICAL_AUDIT_PRE_MARKETING.md`; `docs/RESILIENCE_UPGRADE_SUMMARY.md`).  
- Audit uses `ip_hash`, `api_key_id` (no raw keys); `apps/api/src/auth.ts` hashing; non-sensitive logging considerations in docs.

**Missing (where to inject):**

- No **local vs cloud** split in the data model: all memory is cloud (Supabase).  
- No `sync_status`, `last_synced_at`, or `storage_tier` on memories.  
- No “sensitive” flag or local-only storage path.  
- **Injection points:**  
  - Add optional columns e.g. `memories.storage_tier` (‘local’ | ‘cloud’ | ‘synced’), `memories.last_synced_at`, `memories.sensitive` (boolean).  
  - Edge logic: API could refuse to sync `sensitive` to cloud or only sync metadata; SDK or a separate “edge” build could support local-first writes with sync queue.  
  - New endpoint or MCP resource for “local memories” vs “cloud memories” if you introduce local storage (e.g. in a future client SDK).

---

## 3. Next 3 Steps (High Priority to MVP)

1. **Add MCP server and at least one memory tool + one resource**  
   - Implement a minimal MCP server (e.g. in `packages/mcp-server` or `apps/mcp`) that:  
     - Exposes a **tool** `memory_search` (and optionally `memory_add` / `get_context`) calling existing `/v1/search`, `/v1/memories`, `/v1/context` with an API key from MCP config.  
     - Exposes a **resource** URI (e.g. `memory://search?q=...`) implemented via `readResource` → internal call to search API.  
   - This makes the SDK “agent-ready” for 2026 and allows any MCP client to use MemoryNode as the memory backend without custom glue.

2. **Introduce episodic event store for agent/tool runs**  
   - Add a dedicated table (e.g. `agent_events` or `episode_log`) with: `workspace_id`, `user_id`, `session_id`, `event_type` (e.g. ‘tool_call’, ‘agent_step’), `tool_name`, `input_summary`, `output_summary`, `created_at`, optional `memory_ids` (linked memories).  
   - Add a small API surface: e.g. `POST /v1/episodes` (append) and `GET /v1/episodes?session_id=...&start_time=...&end_time=...` for temporal recall.  
   - Optionally wire MCP tool invocations to append to this store so “what the agent did” is first-class episodic memory.

3. **Implement one memory-hygiene upgrade: summarization or weight decay**  
   - **Option A — Summarization:** Add a scheduled or on-demand job that, per user/namespace, selects recent or high-signal memories, calls an LLM to produce a short summary, and stores it (e.g. as a synthetic “note” memory or in a `memory_summaries` table). Expose “summary” in context or search (e.g. include in `/v1/context` or a new `GET /v1/summary`).  
   - **Option B — Weight decay:** Add `last_accessed_at` (or `access_count`) to `memory_chunks`/`memories`; in search RPC or a nightly job, apply time/decay factor to relevance so older or rarely retrieved memories rank lower (or are excluded below a threshold).  
   - Doing one of these (preferably summarization for “smart context”) positions the SDK as “hygiene-aware” and improves long-horizon agent behavior.

---

## 4. Summary

| Pillar | Status | Primary locations |
|--------|--------|-------------------|
| Episodic | Partial | `api_audit_log`, `product_events`, `search_query_history`, time filters in `match_chunks_*`, `workerApp.ts` parseIsoTimestamp + filters |
| Semantic | Present | `memory_chunks.embedding`, `embedText`, `match_chunks_vector`/`_text`, `memories.ts` EXTRACTION_PROMPT / memory_type, contracts + SDK |
| Procedural/Graph | Partial | `027_smart_memory_upgrade.sql` (`duplicate_of`, `source_memory_id`, `find_near_duplicate_memories`); no general graph |
| MCP | Absent | No mcp/, readResource, callTool; add package or app + tools/resources |
| Memory hygiene | Partial | `admin.ts` handleMemoryHygiene, RRF + min_score; add summarization or decay |
| Privacy/Edge | Partial | Docs + hashed audit; add storage_tier / sync metadata and optional local-first path |

Completing **MCP integration**, **episodic event store**, and **one hygiene upgrade** (summarization or decay) will bring the SDK to an MVP that meets 2026 next-gen memory expectations for agentic workflows and MCP.
