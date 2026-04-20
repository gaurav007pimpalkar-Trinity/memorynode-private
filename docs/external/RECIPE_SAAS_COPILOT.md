## ℹ️ Supporting Documentation

This document is a guide.  
For exact API behavior, refer to:
- `docs/external/API_USAGE.md`
- `docs/external/openapi.yaml` (run `pnpm openapi:gen` to regenerate)

---

# Recipe: SaaS copilot (per-tenant, per-user)

**Goal:** Your product has **accounts** and **logged-in users**. The in-app copilot should only recall **that account’s** memories, and optionally only **that user’s** slice.

## Model

- **Project:** your MemoryNode project (one API key per production environment is typical).
- **`userId`:** recommended pattern: `{tenant_id}:{app_user_id}` so two customers never collide. Example: `org_abc:user_xyz`.
- **`scope`:** product surface — e.g. `copilot`, `settings`, `onboarding` — so marketing memories do not appear inside the code assistant.

## 1. Store a preference when the user changes settings

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "org_abc:user_xyz",
    "scope": "copilot",
    "text": "User prefers API examples in TypeScript and wants rate-limit warnings in the UI.",
    "metadata": { "surface": "settings" }
  }'
```

## 2. On each copilot turn, attach context

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/context" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "org_abc:user_xyz",
    "scope": "copilot",
    "query": "How should I explain rate limits to this user?",
    "top_k": 6
  }'
```

## 3. Next.js edge pattern

If your BFF runs on the edge, keep the **API key on the server** only. See the repo’s [Next.js middleware example](../../examples/nextjs-middleware/README.md) for passing `userId` / `scope` from the session after you authenticate the user.

## Tips

- **Never send the MemoryNode API key to the browser** for this flow — call MemoryNode from your backend or edge.
- Use **`memory_type`** (`fact`, `preference`, `event`, `note`) if you want filters on list endpoints ([API usage](./API_USAGE.md)).

Legacy aliases (`user_id`, `namespace`) remain supported for compatibility.
