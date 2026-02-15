# MemoryNode Performance

Operational guidance for vector search latency, index tuning, and query caps.

---

## Vector search

- **Backend:** pgvector (Supabase) with cosine distance; IVFFlat index on `memory_chunks.embedding`.
- **Hybrid retrieval:** Vector + full-text (tsvector) with Reciprocal Rank Fusion (RRF).
- **Embedding model:** `text-embedding-3-small` (1536 dimensions) when `EMBEDDINGS_MODE=openai`.

### Latency

- **p95/p99 targets:** See OBSERVABILITY.md §4. Latency SLO is staged; measure baseline before publishing.
- **Health view:** Tracks p99 latency per route_group; p99 for 5xx ("time to fail") for on-call.
- **Signals:** `search_request` (search_latency_ms, result_count); `db_rpc` (match_chunks_vector, match_chunks_text).

### Index tuning

- **IVFFlat lists:** Default 100 (see `memory_chunks_embedding_idx` in `infra/sql/001_init.sql`). For larger tables, consider increasing (e.g. `sqrt(row_count)` or higher) and reindexing.
- **Full-text:** GIN index on `tsv` (tsvector). English stemming; `websearch_to_tsquery` for user queries.
- **Reindex:** After bulk imports or schema changes, run `REINDEX INDEX CONCURRENTLY` if needed (Supabase / Postgres docs).

### Query complexity caps

- **top_k:** Max 100 (MAX_TOPK in `apps/api/src/limits.js`).
- **page_size:** Max 50.
- **Match count:** `SEARCH_MATCH_COUNT` caps vector/text fetch before fusion; `MAX_FUSE_RESULTS` caps fused output.
- **Per-tenant caps:** `usage_daily` enforces plan limits (reads, writes, embeds). Rate limiting per API key (RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS).

---

## Abuse and cost containment

- **Rate limiting:** Durable Object (RATE_LIMIT_DO); configurable max requests per window.
- **Per-tenant caps:** Plan limits (Launch/Build/Deploy/Scale/Scale+) in `usage_daily`; `cap_exceeded` event when exceeded. See [Plans & Limits](README.md#plans--limits).
- **Alerts:** 429 rate per tenant (operational KPI); anomaly alerts for 401/403 spikes, webhook failures — see ALERTS.md and OPERATIONS.md.

---

## Related

- **OBSERVABILITY.md** — Golden metrics, SLO definitions, health view
- **ALERTS.md** — Alert rules and thresholds
- **OPERATIONS.md** — Incident checklist, rate-limit handling
