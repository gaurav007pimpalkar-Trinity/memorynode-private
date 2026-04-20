# E2E critical path — manual verification

Run this flow once before launch to confirm the full user journey works.

---

## Flow (in order)

1. **Sign in to dashboard**  
   Open the dashboard URL (e.g. `https://console.memorynode.ai`). Sign in with Supabase (magic link or GitHub OAuth).

2. **Create or select project**  
   Create a project or pick an existing one. Ensure you’re in a project before creating an API key.

3. **Create API key**  
   In the API Keys tab, create a new API key. Copy and store it (it’s shown only once).

4. **Add memory (via API or dashboard)**  
   - **Option A (dashboard):** In Memory Browser, add a memory (if the UI supports it).  
   - **Option B (API):** Use the API key with `POST /v1/memories`:
     ```bash
     curl -X POST "https://api.memorynode.ai/v1/memories" \
       -H "x-api-key: YOUR_API_KEY" \
       -H "content-type: application/json" \
       -d '{"userId":"user-1","scope":"default","text":"My favorite color is blue."}'
     ```

5. **Search**  
   - **Option A (dashboard):** Use the Retrieval tab to run a search.  
   - **Option B (API):**
     ```bash
     curl -X POST "https://api.memorynode.ai/v1/search" \
       -H "x-api-key: YOUR_API_KEY" \
       -H "content-type: application/json" \
       -d '{"userId":"user-1","scope":"default","query":"favorite color"}'
     ```
   Confirm you get the memory you added (or relevant results).

6. **(Optional) Billing**  
   If PayU is enabled: open Settings → Billing, start checkout, and confirm redirect and return flow (or run a test payment).

---

## Quick API-only check (no dashboard UI)

If you already have a project and API key (e.g. from staging or admin):

```bash
# Set your production API key
export MEMORYNODE_API_KEY="mn_live_..."

# Health
curl -s "https://api.memorynode.ai/healthz" | jq .

# Add memory
curl -s -X POST "https://api.memorynode.ai/v1/memories" \
  -H "x-api-key: $MEMORYNODE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"userId":"e2e-user","scope":"default","text":"E2E test memory added at '"$(date -Iseconds)"'"}' | jq .

# Search
curl -s -X POST "https://api.memorynode.ai/v1/search" \
  -H "x-api-key: $MEMORYNODE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"userId":"e2e-user","scope":"default","query":"E2E test"}' | jq .
```

On Windows PowerShell, use `$env:MEMORYNODE_API_KEY = "mn_live_..."` and run the same `curl` commands.

---

## Automated smoke (staging/production)

For a scripted smoke that creates project + key + memory + search, use:

```bash
BASE_URL=https://api.memorynode.ai pnpm prod:smoke
```

Requires `MASTER_ADMIN_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `API_KEY_SALT` (and optionally `OPENAI_API_KEY` if not using stub). See `.env.prod.smoke.example` or the runbook.
