# Recipe: support-style agent memory

**Goal:** When a customer talks to your support bot, it should **remember** ticket facts (order id, prior issue, what was promised) instead of asking the same questions again.

**Time:** about 10 minutes after you have an API key.

## Model

- **`user_id`:** use a stable id for the **end customer** (your CRM user id, or `support:{email}` hashed if you must).
- **`namespace`:** e.g. `support` or `support:acme` so product memory does not mix with marketing chat.

## 1. Save a fact after each resolved turn (or on ticket close)

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "cust_42",
    "namespace": "support",
    "text": "Ticket T-9012: shipping address corrected to Mumbai; promised refund in 3–5 days on 2026-04-10.",
    "metadata": { "ticket": "T-9012", "channel": "email" }
  }'
```

## 2. Before the model answers, search

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "cust_42",
    "namespace": "support",
    "query": "refund shipping address T-9012",
    "top_k": 5
  }'
```

## 3. Or fetch prompt-ready context in one call

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/context" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "cust_42",
    "namespace": "support",
    "query": "What did we promise this customer about refunds?",
    "top_k": 8
  }'
```

Use `context_text` in your system or developer message; use `citations` if you want the model to cite memory ids.

## Tips

- **Write short, factual strings** — easier to retrieve than huge transcripts.
- **On escalation**, store a one-line summary so the human agent inherits the same memory id space.
- **Multi-tenant B2B:** encode tenant in `user_id` or `namespace` so workspaces never leak (e.g. `user_id`: `tenantA:u42`).

See also: [Node quickstart example](../../examples/node-quickstart/README.md) for a runnable script pattern.
