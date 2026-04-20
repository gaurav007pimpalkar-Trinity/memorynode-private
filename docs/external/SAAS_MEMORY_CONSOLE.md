## ℹ️ Supporting Documentation

This document is a guide.  
For exact API behavior, refer to:
- `docs/external/API_USAGE.md`
- `docs/external/openapi.yaml` (run `pnpm openapi:gen` to regenerate)

---

# SaaS Memory Console (Phase 2)

This guide defines the SaaS-layer continuity demo on top of the shared Memory Engine.

## Who this is for

Teams shipping customer-facing AI experiences that must prove user memory continuity quickly.

## Core demo goal

Show, in under 2 minutes: **“This user was remembered.”**

## Dashboard demo flow

1. Open the dashboard and switch to **SaaS Memory Console**.
2. Open **Continuity**.
3. Enter `userId` (example: `user_123`).
4. Keep demo memory text (`User prefers dark mode`) or edit it.
5. Click **Run continuity demo**.
6. Confirm all three outputs appear:
   - Last memory for that user
   - Retrieved context for returning-user simulation
   - Last interaction timestamp
7. Confirm final state message: **This user was remembered.**

## Copy-paste API example (same flow)

```bash
export API_KEY=mn_live_xxx
export USER_ID=user_123

# Step 1: store memory
curl -sS -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"'"$USER_ID"'","scope":"saas-demo","text":"User prefers dark mode"}'

# Step 2: simulate returning user and fetch context
curl -sS -X POST "https://api.memorynode.ai/v1/context" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"'"$USER_ID"'","scope":"saas-demo","query":"What do we know about this user preferences?"}'

# Optional: inspect latest memory for this user
curl -sS -G "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode "userId=$USER_ID" \
  --data-urlencode "scope=saas-demo" \
  --data-urlencode "page=1" \
  --data-urlencode "page_size=1"
```

## Scope (this phase)

- Primary: continuity proof only.
- Secondary metrics and advanced personalization controls are intentionally out of the central SaaS flow for now.

Legacy aliases (`user_id`, `namespace`) remain supported for compatibility.
