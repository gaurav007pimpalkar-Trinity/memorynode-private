# MemoryNode Quickstart (≤10 minutes)

## Prereqs
- Node.js 20+, `corepack`, `wrangler` (Cloudflare), git.
- Supabase project (URL + service role key).
- PayU billing keys optional for local; not needed to ingest/search in stub mode. Billing uses PayU; see docs/BILLING_RUNBOOK.md.

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
Use templates only; never commit `.env*`/`.dev.vars*` files with real values.
For deployed environments, set real secrets in Cloudflare (`wrangler secret put <NAME>`).
Minimum required (local):
```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=sk-...           # or set EMBEDDINGS_MODE=stub
API_KEY_SALT=dev_salt_12345
MASTER_ADMIN_TOKEN=dev_admin
ALLOWED_ORIGINS=http://127.0.0.1:4173
EMBEDDINGS_MODE=stub
PUBLIC_APP_URL=http://127.0.0.1:4173
```
For production billing (PayU), also set: `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_VERIFY_URL`, `PAYU_BASE_URL`, and optionally `PAYU_WEBHOOK_SECRET`. See docs/PROD_SETUP_CHECKLIST.md and docs/BILLING_RUNBOOK.md.

## 3) Apply migrations (canonical path, deterministic)
Set DB connection and run the scripted migrator (this is the source of truth; do not run SQL files manually out-of-band):

```bash
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require pnpm db:migrate
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require pnpm db:verify-rls
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require pnpm db:verify-schema
```

You may use `SUPABASE_DB_URL` instead of `DATABASE_URL`.

Print the exact ordered migration manifest from filesystem:

```bash
pnpm migrations:list
```

Migration manifest (CI-checked): `MIGRATIONS_TOTAL=28; MIGRATIONS_LATEST=026_retrieval_cockpit.sql`

## 4) Run the API locally
```bash
corepack pnpm dev:api   # starts wrangler dev, prints base URL (default 8787)
```

## Green checks (should pass before PR)
- pnpm install
- pnpm lint
- pnpm typecheck
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
4. Ingest one memory (curl below); then run one search. See `docs/FIRST_RUN_FLOW.md`.

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

More: see `docs/TROUBLESHOOTING_BETA.md` for the full symptom → fix playbook.

## 9) Next steps

| Goal | Doc |
| --- | --- |
| Full API reference | `docs/API_REFERENCE.md` |
| Deploy to production | `docs/PROD_SETUP_CHECKLIST.md` → `docs/RELEASE_RUNBOOK.md` |
| Monitor production | `docs/OBSERVABILITY.md` (health checklist) → `docs/ALERTS.md` (alert triage) |
| PayU billing ops | `docs/BILLING_RUNBOOK.md` |
| Secret rotation | `docs/SECURITY.md` |
| Run tests | `pnpm test` (Vitest, 150+ tests; shared helpers in `apps/api/tests/helpers/`) |
| Smoke test | `pnpm smoke` (macOS/Linux) or `pnpm smoke:ps` (Windows) |
