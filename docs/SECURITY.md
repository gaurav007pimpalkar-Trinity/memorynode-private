# MemoryNode Security

## Our Security Stance

**What we do:**

- **Authentication:** Supabase Auth (magic link, OAuth); session tokens in httpOnly cookies for dashboard; API keys for programmatic access.
- **Authorization (Phase A, startup-safe):** Request-path access remains on the current architecture, but critical tenant flows are fail-closed (no scoped-to-direct fallback), tenant isolation is enforced with workspace scoping + RLS policies, and CI blocks service-role creep via an explicit allowlist boundary. Service-role usage is allowed only in approved modules and rejected elsewhere by CI. Full `rls-first` request-scoped credentials are deferred to a later phase.
- **Credentials:** We never store long-lived API keys in the browser. Keys are shown once at creation; thereafter only prefix in UI.
- **Audit trail:** API request logs (route, method, status, workspace); billing webhook events; retention per DATA_RETENTION.md.
- **Billing:** PayU with hash verification, verify-before-grant, idempotency. Webhook payloads do not grant access until verified.
- **Headers:** CSP, X-Content-Type-Options, Referrer-Policy; CSRF protection on mutating dashboard calls.

**What we don’t do:**

- Store raw API keys in localStorage, sessionStorage, or IndexedDB.
- Grant entitlements from unverified webhook payloads.
- Ship demo or hardcoded auth in production.

**Data handling:** Where it lives, who can access, retention — see [DATA_RETENTION.md](./DATA_RETENTION.md).

---

## Secrets & Credential Hygiene

## Rules

- Never commit real credentials to git.
- Use tracked templates only:
  - `.env.example`
  - `apps/api/.dev.vars.template`
  - `apps/dashboard/.env.example`
- Put real runtime secrets in Cloudflare Worker secrets (`wrangler secret put <NAME>` or Cloudflare Dashboard).

## Local Files

- Real values belong in local untracked files only (`.env`, `.env.local`, `.dev.vars`, `.dev.vars.production`, etc.).
- Do not add backup copies of env/wrangler files to git.

## Required Scans

- Staged diff scan (pre-commit style):
  - `pnpm secrets:check`
- Full tracked-file scan:
  - `pnpm secrets:check:tracked`
- CI enforces tracked-file scanning and fails fast on detection.

## Optional Pre-Commit Hook

- Example hook script: `scripts/precommit.sh`
- One simple setup:
  - `cp scripts/precommit.sh .git/hooks/pre-commit`
  - `chmod +x .git/hooks/pre-commit`
- Husky users can call the same command sequence from `.husky/pre-commit`.

---

## PayU Secrets — Requirements, Storage, & Least-Privilege

### Secret Inventory

| Secret | Where stored | Purpose | Who needs access |
| --- | --- | --- | --- |
| `PAYU_MERCHANT_KEY` | Cloudflare Worker secret | Identifies the merchant for PayU API calls and webhook hash verification | API Worker only |
| `PAYU_MERCHANT_SALT` | Cloudflare Worker secret | HMAC-SHA512 hash computation for checkout requests and webhook signature verification | API Worker only |
| `PAYU_WEBHOOK_SECRET` | Cloudflare Worker secret | **Required in production** when billing is enabled (`scripts/check_config.mjs`); `x-payu-signature` verification when set in PayU dashboard | API Worker only |

### Storage Rules

1. **Never** store PayU secrets in `wrangler.toml [vars]`, `.env` files committed to git, or CI logs.
2. **Always** use `wrangler secret put` or the Cloudflare Dashboard Secrets UI.
3. **Staging and production** MUST use separate PayU merchant accounts (or at minimum separate salt values).
4. Secrets are accessible only to the Worker runtime — no dashboard user, CI pipeline, or log output should ever see the raw value.

### Least-Privilege Guidance

- **API Worker**: needs `PAYU_MERCHANT_KEY` and `PAYU_MERCHANT_SALT` at runtime. Does NOT need PayU dashboard admin access.
- **Operators/Founders**: need PayU dashboard access for configuration only. Should NOT have raw salt values in personal env files.
- **CI/CD**: does NOT need PayU secrets. Deployments use `wrangler deploy`; secrets are already bound to the Worker.
- **Dashboard app**: does NOT need PayU secrets. Billing flows go through the API.

### Mandatory Security Controls

These are **non-negotiable** for production:

1. **Webhook signature verification**: every inbound PayU callback MUST have its hash verified against `PAYU_MERCHANT_SALT` before any side-effects are applied. The API enforces this in the webhook handler — see `apps/api/src/handlers/webhooks.ts` → `isPayUWebhookSignatureValid()`.

2. **Verify-before-grant**: entitlements (plan upgrades, subscription activation) are granted ONLY after the PayU Verify API confirms the transaction status. The webhook handler calls `reconcilePayUWebhook()` which includes verify-before-grant logic. This prevents:
   - Forged webhook payloads from granting entitlements.
   - Race conditions between webhook delivery and transaction settlement.

3. **Idempotency**: duplicate webhook deliveries are safely handled via `event_id` deduplication (`webhook_replayed` event).

4. **Deferred processing**: if a webhook arrives before workspace mapping exists, it is parked (not dropped) and can be reprocessed via `POST /admin/webhooks/reprocess`.

---

## Dashboard session (no API key in browser)

- **No long-lived API keys in the dashboard.** The dashboard never stores API keys in `localStorage`, `sessionStorage`, or IndexedDB. CI gate G2 enforces an allowlist for browser storage (e.g. `theme`, `workspace_id` only).
- **Session-based auth:** The dashboard authenticates to the API via a short-lived session token in an **httpOnly, SameSite=Lax, Secure** cookie (`mn_dash_session`). The token is minted by the Worker after validating the Supabase access token and workspace membership.
- **Endpoints:** `POST /v1/dashboard/session` (body: `access_token`, `workspace_id`) creates a session and sets the cookie; response body includes `csrf_token` for mutating requests. `POST /v1/dashboard/logout` invalidates the session and clears the cookie.
- **CSRF (locked approach):** SameSite=Lax cookies **plus** Origin validation **plus** CSRF token for all mutating dashboard API calls (POST/PUT/DELETE/PATCH). The Worker returns `csrf_token` in the session response; the dashboard sends it in the `X-CSRF-Token` header on every mutating request. **Allowed origins:** Configure `ALLOWED_ORIGINS` in the Worker (comma-separated). Must include the production dashboard origin (e.g. `https://console.memorynode.ai`), staging, and preview pattern (e.g. `https://*.vercel.app` or your PR preview URL). Browser requests with an `Origin` header are rejected if the origin is not in the allowlist. Non-browser API clients (no `Origin` header) are allowed on non-dashboard endpoints (e.g. programmatic API key calls).
- **Session lifetime and refresh:** Access token (session cookie) TTL is **15 minutes**. There is no refresh cookie in Phase 0; when the session expires the user must sign in again (dashboard will get 401 and clear state). **Idle timeout** and **absolute max session** (e.g. 12 h) are documented here; optional enforcement can be added later (e.g. sliding expiry on activity, or max session length). Session loss on deploy is acceptable in Phase 0; users re-auth.
- **API key create/reveal:** Keys are created via Supabase RPC (`create_api_key`). The plaintext key is shown **once** at creation; the dashboard does not store it. List/revoke use Supabase RPC and session-authenticated API where needed.
- **Rotation and revoke:** **Revoke** is supported in both UI and API (e.g. `POST /v1/api-keys/revoke` with `api_key_id`; Supabase RPC `revoke_api_key(key_id)`). **Rotation** = create a new key (same workspace/name or new name) then revoke the old key. **Grace-period rotation:** When rotating, the old key can remain valid for a short window (e.g. 24 hours) so integrations can switch to the new key before the old one is revoked. Implement by: (1) create new key and distribute to clients, (2) wait for grace period (e.g. 24 h) or until clients confirm switch, (3) call revoke on the old key. Documented in API_REFERENCE.md.

---

## CSP and security headers (dashboard)

- **Content-Security-Policy (CSP):** The dashboard deploy sends CSP via `public/_headers` (Cloudflare Pages) or `vercel.json` (Vercel). Script-src is `'self'` only (no `unsafe-inline` for scripts). **CSP exception process:** Any exception must have a **linked issue**, **reason**, **scope**, and **due date to remove**. Current exception: **style-src 'unsafe-inline'** — reason: inline styles in `index.html`; scope: dashboard; remove when styles are moved to external CSS.
- **Other headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` (minimal). Set on the dashboard host (Pages/Vercel) so all dashboard responses include them.
- **G5:** CI checks that the dashboard (PR preview or staging) returns CSP and required headers; see `scripts/ci_trust_gates.mjs` and workflow.

---

## Rotation Playbook (if a secret is exposed)

### General Steps

1. Revoke/rotate immediately in provider dashboard.
2. Update Cloudflare Worker secret values (staging + production).
3. Redeploy and verify health/smoke checks.
4. Invalidate dependent credentials/tokens (API keys, sessions, webhooks).
5. Document incident, blast radius, and closure.

### OpenAI (`OPENAI_API_KEY`)

- Generate a new key in OpenAI dashboard.
- Disable old key.
- Update Worker secret and redeploy.

### Supabase (`SUPABASE_SERVICE_ROLE_KEY`)

- Rotate service-role key in Supabase project settings.
- Update Worker secret and any secure automation that uses it.
- Redeploy and run DB/API smoke tests.

### PayU (`PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, optional `PAYU_WEBHOOK_SECRET`)

**Rotation steps:**

1. **Assess blast radius**: determine if the exposed secret was merchant key, salt, or both.
   - If only `PAYU_MERCHANT_KEY`: attackers can identify the merchant but cannot forge signatures.
   - If `PAYU_MERCHANT_SALT`: attackers can forge webhook signatures — **treat as critical**.
2. **Rotate in PayU dashboard**:
   - Log in to PayU merchant dashboard.
   - Navigate to Settings → API Configuration.
   - Generate new merchant key/salt.
   - Note: PayU may require contacting support for salt rotation.
3. **Update Worker secrets** (do staging first, then production):

   ```bash
   pnpm --filter @memorynode/api exec wrangler secret put PAYU_MERCHANT_KEY --env staging
   pnpm --filter @memorynode/api exec wrangler secret put PAYU_MERCHANT_SALT --env staging
   # Verify staging:
   TARGET_ENV=staging STAGING_BASE_URL=https://api-staging.memorynode.ai API_KEY=<key> pnpm release:staging:validate

   pnpm --filter @memorynode/api exec wrangler secret put PAYU_MERCHANT_KEY --env production
   pnpm --filter @memorynode/api exec wrangler secret put PAYU_MERCHANT_SALT --env production
   ```

4. **Verify webhook path**: send a test PayU callback and confirm `webhook_verified` + `webhook_processed` appear in Worker logs.
5. **Check for forged transactions**: query `billing_events` table for any transactions that arrived between exposure and rotation. Cross-reference with PayU dashboard transaction list.
6. **If forged entitlements found**:
   - Revoke affected workspace entitlements.
   - Notify affected users.
   - Document in incident report.

**Downtime note**: between rotating in PayU dashboard and updating Worker secrets, inbound webhooks will fail signature verification (`billing_webhook_signature_invalid`). Keep this window as short as possible (<5 minutes).

### Internal Admin Secrets (`MASTER_ADMIN_TOKEN`, `API_KEY_SALT`, optional `ADMIN_ALLOWED_IPS`)

- Generate fresh random values.
- Update Worker secrets.
- For `API_KEY_SALT`, rotate API keys after update.
- **`ADMIN_ALLOWED_IPS`**: optional comma-separated exact IPs for `x-admin-token` routes (`cf-connecting-ip`). Use in production to restrict admin API to known egress (CI, bastion). Set to `*` only as a temporary break-glass (disables IP check).
- **Signed admin auth (recommended default for staging/prod):** require `x-admin-timestamp`, `x-admin-nonce`, and `x-admin-signature` (HMAC-SHA256 over `METHOD\\nPATH\\nTIMESTAMP\\nNONCE` using `MASTER_ADMIN_TOKEN` as key). Requests older than 5 minutes or nonce replays are rejected.
- **Break-glass mode:** set `ADMIN_BREAK_GLASS=1` only during emergency operations to temporarily allow legacy `x-admin-token`; all break-glass auth events must be audited and rotated immediately after use.

---

## Incident Response — PayU Secret Compromise

| Step | Action | Owner | SLA |
| --- | --- | --- | --- |
| 1 | Confirm exposure scope (which secrets, which environments) | On-call | <15 min |
| 2 | Rotate secrets in PayU dashboard | On-call + PayU admin | <30 min |
| 3 | Update Worker secrets and redeploy | On-call | <15 min after step 2 |
| 4 | Verify webhook flow end-to-end | On-call | <15 min after step 3 |
| 5 | Audit transactions for forgery | On-call | <2 hours |
| 6 | Revoke forged entitlements (if any) | On-call | <1 hour after step 5 |
| 7 | Write incident report | On-call | <24 hours |

---

## GitHub Secret Scanning

- Enable GitHub Secret Scanning and Push Protection on the repository (if hosted on GitHub with eligible plan).
- On alert:
  1. Treat as active incident.
  2. Rotate secret first, then clean repository/workflow exposure.
  3. Close alert only after redeploy + verification.
