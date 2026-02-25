# Retrieval Quality Cockpit — End-to-End Demo

Phase 5 feature: eval sets, replayable queries, explainability, embedding visibility.

## 1. Embedding model visibility

```bash
curl http://127.0.0.1:8787/healthz
```

Response includes `embedding_model`: `text-embedding-3-small` (OpenAI) or `stub` (local dev).

---

## 2. Explainability (“why this result”)

Add `explain: true` to search to get per-result match details:

```bash
curl -X POST "$BASE/v1/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u1","query":"project deadlines","explain":true}'
```

Each result includes:

```json
{
  "chunk_id": "...",
  "memory_id": "...",
  "text": "...",
  "score": 0.15,
  "_explain": {
    "rrf_score": 0.15,
    "match_sources": ["vector", "text"],
    "vector_score": 0.82,
    "text_score": 0.05
  }
}
```

- `match_sources`: `["vector"]`, `["text"]`, or `["vector","text"]` — which retrieval paths contributed
- `vector_score`: cosine similarity (0–1) from vector search
- `text_score`: ts_rank from full-text search
- `rrf_score`: Reciprocal Rank Fusion combined score

---

## 3. Replayable queries

### Save a search to history

```bash
curl -X POST "$BASE/v1/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Save-History: true" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"u1","query":"quarterly goals"}'
```

### List saved queries

```bash
curl "$BASE/v1/search/history?limit=10" -H "Authorization: Bearer $API_KEY"
```

### Replay and compare

```bash
# Get query_id from history, then:
curl -X POST "$BASE/v1/search/replay" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query_id":"<uuid-from-history>"}'
```

Response:

```json
{
  "query_id": "...",
  "previous": { "results": [...], "total": 5, "page": 1, "has_more": false },
  "current": { "results": [...], "total": 6, "page": 1, "has_more": false }
}
```

Compare `previous` vs `current` to see how retrieval changed (e.g. after adding memories or tuning).

---

## 4. Evaluation sets

### Create eval set

```bash
curl -X POST "$BASE/v1/eval/sets" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"smoke-eval"}'
```

### Add eval items (query + expected memory IDs)

```bash
# After ingesting memories, note their IDs. Then:
curl -X POST "$BASE/v1/eval/sets/$EVAL_SET_ID/items" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"Q1 roadmap","expected_memory_ids":["mem-uuid-1","mem-uuid-2"]}'
```

### Run eval

```bash
curl -X POST "$BASE/v1/eval/run" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"eval_set_id":"'$EVAL_SET_ID'","user_id":"u1"}'
```

Response:

```json
{
  "eval_set_id": "...",
  "items": [
    {
      "item_id": "...",
      "query": "Q1 roadmap",
      "expected": ["mem-uuid-1", "mem-uuid-2"],
      "retrieved": ["mem-uuid-1", "mem-uuid-3", "..."],
      "precision_at_k": 0.5,
      "recall": 0.5
    }
  ],
  "summary": {
    "count": 1,
    "avg_precision_at_k": 0.5,
    "avg_recall": 0.5
  }
}
```

---

## 5. End-to-end flow

1. Ingest memories (see `docs/QUICKSTART.md` §7).
2. Run a search with `explain: true` to inspect match sources and scores.
3. Save a search with `X-Save-History: true`.
4. Add more memories or change data.
5. Replay the saved search and compare `previous` vs `current`.
6. Create an eval set, add items (query + expected memory IDs), run eval to measure precision/recall.
7. Iterate on chunking, embeddings, or filters to improve retrieval quality.
