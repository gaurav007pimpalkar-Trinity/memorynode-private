# QUICKSTART

**MemoryNode lets you store, retrieve, and explain why AI remembered something.**

## Get API key

1. Open `https://console.memorynode.ai`, create/select a workspace.
2. Go to **API Keys** -> **Create API Key** -> copy the `mn_live_...` value.

## Your First Working Memory (60 seconds)

```bash
export API_KEY="mn_live_your_key_here"
export USER_ID="user-123"
export NAMESPACE="myapp"

curl -sS -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$USER_ID\",\"namespace\":\"$NAMESPACE\",\"text\":\"User prefers dark mode\"}"

curl -sS -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$USER_ID\",\"namespace\":\"$NAMESPACE\",\"query\":\"theme preference\",\"top_k\":5}"

curl -sS -X POST "https://api.memorynode.ai/v1/context" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$USER_ID\",\"namespace\":\"$NAMESPACE\",\"query\":\"What do we know about theme preferences?\",\"top_k\":5}"

curl -sS -G "https://api.memorynode.ai/v1/context/explain" \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode "user_id=$USER_ID" \
  --data-urlencode "namespace=$NAMESPACE" \
  --data-urlencode "query=What do we know about theme preferences?" \
  --data-urlencode "top_k=5"
```

### Example interpretation

- higher `relevance_score` -> semantically matched query
- higher `recency_score` -> recently accessed memory
- higher `importance_score` -> manually or implicitly boosted memory
- `final_score` determines ranking order

Step 4 (Aha): See exactly why this was chosen.

```json
{
  "query": "user onboarding issue",
  "top_result": "User struggles with login flow due to expired token",
  "scores": {
    "relevance_score": 0.91,
    "recency_score": 0.78,
    "importance_score": 0.84,
    "final_score": 0.88
  },
  "ordering_explanation": "High semantic match + recent access pattern boosted ranking"
}
```

Why this was chosen: high semantic match and recent usage signals pushed this memory above alternatives.

Flow mental model:

- store -> capture memory
- search -> recall relevant memory
- context -> use memory in AI response
- explain -> prove why it was used
