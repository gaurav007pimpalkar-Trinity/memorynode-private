# QUICKSTART

**MemoryNode lets you store, retrieve, and explain why AI remembered something.**

## Get API key

1. Open `https://console.memorynode.ai`, create/select a project.
2. Go to **API Keys** -> **Create API Key** -> copy the `mn_live_...` value.

## Your First Working Memory (60 seconds)

```bash
export API_KEY="mn_live_your_key_here"
export USER_ID="user-123"
export SCOPE="myapp"

curl -sS -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"scope\":\"$SCOPE\",\"text\":\"User prefers dark mode\"}"

curl -sS -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"scope\":\"$SCOPE\",\"query\":\"theme preference\",\"top_k\":5}"

curl -sS -X POST "https://api.memorynode.ai/v1/context" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"scope\":\"$SCOPE\",\"query\":\"What do we know about theme preferences?\",\"top_k\":5}"

curl -sS -G "https://api.memorynode.ai/v1/context/explain" \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode "userId=$USER_ID" \
  --data-urlencode "scope=$SCOPE" \
  --data-urlencode "query=What do we know about theme preferences?" \
  --data-urlencode "top_k=5"
```

Legacy aliases (`user_id`, `namespace`) are still accepted for compatibility.

## Context explain response

### What `GET /v1/context/explain` returns

The JSON includes a **`query`** object (echo of the params you sent), **`chunk_ids_used`**, **`memories_retrieved`**, and a **`results`** array. Each **`results[i]`** has `rank`, `memory_id`, `chunk_id`, `chunk_index`, `text`, a **`scores`** object (`relevance_score`, `recency_score`, `importance_score`, `final_score`), and **`ordering_explanation`**. You also get pagination fields such as **`total`**, **`page`**, **`page_size`**, and **`has_more`** when applicable.

### How to read each result’s `scores`

- higher `relevance_score` -> semantically matched query
- higher `recency_score` -> recently accessed memory
- higher `importance_score` -> manually or implicitly boosted memory
- `final_score` determines ranking order

### Example (truncated; IDs are illustrative)

```json
{
  "query": {
    "userId": "user-123",
    "scope": "myapp",
    "query": "What do we know about theme preferences?",
    "top_k": 5,
    "search_mode": "hybrid",
    "min_score": null,
    "retrieval_profile": null
  },
  "memories_retrieved": [
    {
      "memory_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "text": "User prefers dark mode."
    }
  ],
  "chunk_ids_used": ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
  "results": [
    {
      "rank": 1,
      "memory_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "chunk_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "chunk_index": 0,
      "text": "User prefers dark mode.",
      "scores": {
        "relevance_score": 0.71,
        "recency_score": 0.99,
        "importance_score": 1,
        "final_score": 0.84
      },
      "ordering_explanation": "Ranked #1 by fused relevance and then adjusted by recency and importance signals."
    }
  ],
  "total": 1,
  "page": 1,
  "page_size": 50,
  "has_more": false
}
```

Why this was chosen: high semantic match and recent usage signals pushed this memory above alternatives (see **`ordering_explanation`** on each **`results`** row).

Flow mental model:

- store -> capture memory
- search -> recall relevant memory
- context -> use memory in AI response
- explain -> prove why it was used

## Continue

1. [PER_USER_MEMORY.md](./PER_USER_MEMORY.md)
2. [SCOPES.md](./SCOPES.md)
3. [ADVANCED_ISOLATION.md](./ADVANCED_ISOLATION.md)
4. [../external/API_USAGE.md](../external/API_USAGE.md)
