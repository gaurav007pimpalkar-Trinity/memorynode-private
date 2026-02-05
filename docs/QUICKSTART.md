# MemoryNode Quickstart (≤10 minutes)

## Prereqs
- Node.js 20+, `corepack`, `wrangler` (Cloudflare), git.
- Supabase project (URL + service role key).
- Stripe keys optional for local; not needed to ingest/search in stub mode.

### pnpm setup (via Corepack)
- Preferred:
  ```bash
  corepack enable
  corepack prepare pnpm@latest-10 --activate
  ```
- If `corepack enable` fails on Windows with EPERM, skip it and run only:
  ```bash
  corepack prepare pnpm@latest-10 --activate
  ```
- On some Windows setups pnpm is only available as `pnpm.cjs`; call it directly (`pnpm.cjs <cmd>`) or add the Corepack pnpm dist folder to `PATH`.

## 1) Clone & install
```bash
git clone <repo>
cd MemoryNode.ai
pnpm install
```

## 2) Env vars
Copy and fill:
```bash
cp .env.example .env
cp apps/api/.dev.vars.template apps/api/.dev.vars   # if template exists
```
Minimum required (local):
```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=sk-...           # or set EMBEDDINGS_MODE=stub
API_KEY_SALT=dev_salt_12345
MASTER_ADMIN_TOKEN=dev_admin
ALLOWED_ORIGINS=http://127.0.0.1:4173
EMBEDDINGS_MODE=stub
STRIPE_SECRET_KEY=dummy
STRIPE_PRICE_PRO=price_pro_dummy
STRIPE_PRICE_TEAM=price_team_dummy
PUBLIC_APP_URL=http://127.0.0.1:4173
```

## 3) Apply migrations (Supabase SQL, in order)
`infra/sql/001_init.sql` → `002_rpc.sql` → `003_usage_rpc.sql` → `004_workspace_plan.sql` → `005_api_audit_log.sql` → `006_rls.sql` → `007_current_workspace_patch.sql` → `008_membership_rls.sql` → `009_workspace_rpc.sql` → `010_api_keys_mask.sql` → `011_api_key_rpcs.sql` → `012_billing.sql` → `013_events.sql` → `014_activation.sql` → `015_invites.sql` → `016_webhook_events.sql`

## 4) Run the API locally
```bash
corepack pnpm dev:api   # starts wrangler dev, prints base URL (default 8787)
```

## Green checks (should pass before PR)
- pnpm install
- pnpm lint
- pnpm -r typecheck
- pnpm test

## 5) Run the dashboard
```bash
cd apps/dashboard
cp .env.example .env.local   # set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_API_BASE_URL
corepack pnpm dev --filter @memorynode/dashboard  # opens http://127.0.0.1:4173
```

## 6) Get an API key (dashboard)
1. Sign in (GitHub OAuth or magic link).
2. Create a workspace (Workspaces tab).
3. Go to API Keys tab → “Create key” → copy the plaintext key (shown once). Save it.

## 7) Curl smoke (replace `<API_KEY>` and `<BASE>` with your worker URL)
```bash
# Ingest
curl -X POST "$BASE/v1/memories" \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"demo-user","namespace":"demo","text":"MemoryNode is great","metadata":{"topic":"demo"}}'

# Search
curl -X POST "$BASE/v1/search" \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"demo-user","namespace":"demo","query":"MemoryNode","top_k":5}'

# Context
curl -X POST "$BASE/v1/context" \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"demo-user","namespace":"demo","query":"MemoryNode","top_k":5}'

# Optional usage
curl -X GET "$BASE/v1/usage/today" \
  -H "Authorization: Bearer <API_KEY>"
```

## 8) Troubleshooting (quick)
| Status | Meaning | Fix |
| --- | --- | --- |
| 401 | Missing/invalid API key | Check `Authorization: Bearer <API_KEY>`; key not revoked; correct workspace. |
| 402 | Cap exceeded | Plan caps hit; upgrade or raise limits; see `cap_exceeded` logs. |
| 413 | Payload too large | Respect body limits (1 MB ingest, 200 KB search/context); chunk or trim. |
| 429 | Rate limited | Back off; honor `Retry-After`; check Durable Object rate limit binding. |
| 500 CONFIG_ERROR | Missing env/binding (e.g., `RATE_LIMIT_DO`, Supabase vars) | Verify `.dev.vars` / Wrangler env and redeploy. |

More: see API reference/OpenAPI and `docs/LAUNCH_CHECKLIST.md` for deployment steps.
