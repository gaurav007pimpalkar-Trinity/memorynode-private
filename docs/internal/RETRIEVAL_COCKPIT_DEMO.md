## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# Retrieval Validation Demo (Current API)

This doc uses only active endpoints in the lean dual-ICP product surface.

## 1. Health + embedding visibility

```bash
curl "$BASE/healthz"
```

Response includes `embedding_model` (for example `text-embedding-3-small` or `stub` in local dev).

## 2. Add sample memories

```bash
curl -X POST "$BASE/v1/memories" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"u1","scope":"default","text":"Q1 roadmap finalized with launch deadline on March 31"}'
```

```bash
curl -X POST "$BASE/v1/memories" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"u1","scope":"default","text":"Customer asked for weekly usage digest emails"}'
```

## 3. Run retrieval search

```bash
curl -X POST "$BASE/v1/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"u1","scope":"default","query":"roadmap deadline","top_k":5}'
```

Verify that:
- Response is `200`.
- `results` is non-empty for known inserted memories.
- Top results are relevant to the query.

## 4. Build prompt-ready context

```bash
curl -X POST "$BASE/v1/context" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"u1","scope":"default","query":"What was the launch deadline?","top_k":5}'
```

Verify that:
- Response is `200`.
- `context_text` (or `citations`) includes expected facts from inserted memories.

## 5. Optional paid import check

```bash
curl -X POST "$BASE/v1/import" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"artifact_base64":"aGVsbG8=","mode":"upsert"}'
```

Expected behavior:
- Free plans: `402 UPGRADE_REQUIRED`.
- Paid plans: `200` with `{ imported_memories, imported_chunks }`.

## 6. MCP flow spot-check

Use MCP with:
- `MEMORYNODE_API_KEY`
- `MEMORYNODE_BASE_URL`
- `MEMORYNODE_USER_ID`
- `MEMORYNODE_NAMESPACE`

(`MEMORYNODE_NAMESPACE` maps to API `scope`.)

Then verify:
- `memory_search` returns relevant snippets.
- `memory_context` returns prompt-ready context text.
- `memory_insert` writes memory visible to subsequent `memory_search`.
