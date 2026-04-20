## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# Production Requirements — No Stubs or Fakes

In **production** (and when `ENVIRONMENT=production` or `staging`), the following must be real. Stub or dev-only modes are **forbidden** and will cause the Worker to return `500 CONFIG_ERROR`.

## Required: Real Services

| Requirement | Env / config | What must be true |
|-------------|--------------|-------------------|
| **Supabase** | `SUPABASE_MODE` ≠ `stub` | Real Supabase project; `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set. |
| **Dashboard auth** | `SUPABASE_ANON_KEY` set | Required for dashboard session flows and runtime config checks. |
| **Origin policy** | `ALLOWED_ORIGINS` set | Must include exact dashboard/app origins used for CORS + CSRF origin checks. |
| **Embeddings** | `EMBEDDINGS_MODE=openai` | Real OpenAI embeddings; `OPENAI_API_KEY` set (valid key). |
| **Rate limiting** | `RATE_LIMIT_MODE` ≠ `off` | Rate limit Durable Object enabled; `RATE_LIMIT_DO` binding set. |

## Enforcement

- **Worker:** On request handling, the Worker checks `ENVIRONMENT`. If production/staging, it throws `CONFIG_ERROR` when:
  - `SUPABASE_MODE=stub`
  - `EMBEDDINGS_MODE=stub`
  - `RATE_LIMIT_MODE=off`
- **Config check:** `pnpm check:config` (and release gate) validates the same for the target stage.
- **Secrets:** `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `API_KEY_SALT`, `MASTER_ADMIN_TOKEN`, and PayU secrets must be set via Wrangler secrets (never in `[vars]` or repo).
- **Entitlement failure policy:** production/staging enforces Launch-plan fallback and blocks paid-only expensive routes during entitlement lookup outages.
- **Quota reconciliation:** reservation refunds are asynchronous; use `/admin/usage/reconcile` for manual reconciliation during incident response.

## Allowed only in development

- `EMBEDDINGS_MODE=stub` — deterministic stub embeddings (no OpenAI calls).
- `SUPABASE_MODE=stub` — in-memory stub DB for tests.
- `RATE_LIMIT_MODE=off` — only when `ENVIRONMENT=dev` (bypasses rate limit).

See `apps/api/.dev.vars.template`, `docs/self-host/LOCAL_DEV.md`, and `scripts/check_config.mjs`.
