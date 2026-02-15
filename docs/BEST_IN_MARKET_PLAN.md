# MemoryNode.ai — Best-in-Market Plan (CEO + CTO)

**Context:** This plan responds to a brutally honest competitor CEO/CTO review (rating: 6.8/10). The goal is to turn MemoryNode.ai into the **best-in-market** product: trusted, operationally proven, and differentiated—not just “working.”

**Ownership:** CEO owns strategy, positioning, and “buyer readiness”; CTO owns execution order, gates, and technical moats.

---

## Part 1: What We Accept From the Review

| Review point | We accept |
|--------------|-----------|
| Dashboard issues are **trust breakers**, not bugs | Hardcoded `user_id`, localStorage keys, no tests, no error boundary = credibility and safety problems. We treat these as P0. |
| 3,100-line index.ts is **outage/scaling risk** | Merge conflicts, review difficulty, blast radius, incident debug time. Modularization is non-negotiable. |
| Env duplication = **config drift** | Single source of truth for `Env` is mandatory. |
| No 405 = **API polish not finished** | Contract correctness and error taxonomy matter for devtools. We fix it. |
| CI/CD must **gate the right things** | If dashboard can ship with no tests, hardcoded user_id, and insecure key storage, CI is not protecting the business. We extend gates to dashboard and security. |
| Observability “on paper” ≠ production-ready | We must answer in **minutes**: p95/p99 per endpoint, error rate per route/tenant, rate-limit triggers, webhook failure/replay, DB/vector search p95, deferred queue depth. |
| Report was CTO pride, not **buyer readiness** | Buyers ask: pain removed, integration speed, 3AM reliability, data trust, retrieval quality. We build evidence for each. |
| Billing is **necessary, not a moat** | Moat = retrieval quality + tuning, developer workflow, reliability + SLAs, compliance, portability. We prioritize accordingly. |
| One security incident = **reputational death** | Key leak via XSS = “Memory product leaked my secrets.” We eliminate the risk before scaling. |
| **First 10 minutes** decide developer tools | White screen, wrong HTTP errors, weird search, localhost surprises = no second chance. Onboarding and first-run experience are product. |

**Competitor attack plan we must neutralize:**
- “Boring but trusted” UI (secure keys, robust auth, error boundaries)
- Operational truth (status page, latency/error transparency, incident playbooks)
- “Retrieval quality cockpit” (eval sets, replayable queries, explainability)
- Frictionless deploy (“works in 5 minutes”)
- “Modular codebase” as their talking point — we make it ours first.

---

## Part 1b: Second Round — Gaps We Close (Competitor Follow-Up)

After publishing the first version of this plan, competitor CEO/CTO feedback: *“Much better than hand-waving; correct moat order and phased approach. But these gaps can sink you if you execute literally as written.”* We close them below.

| Gap | Competitor concern | Our response (in this doc) |
|-----|--------------------|----------------------------|
| **1. Key storage** | “Stop storing keys in localStorage” is not a solution; options imply different architectures; teams stall on half-fixes. | **Chosen approach:** Short-lived session tokens (httpOnly, Secure, SameSite) minted by backend; one-time reveal then prefix only; rotation + revoke; CSP + XSS hardening. No long-lived keys in browser. See Phase 0 § 0.2. |
| **2. Identity + tenancy** | Replacing "dash-user" is not enough; need real identity story: auth → workspace → API key; what when user is removed? | **Document and implement:** Supabase Auth; map auth user → workspace membership → API key entitlements; define behavior when user removed from workspace. See Phase 0 § 0.1 (identity) and § Identity & tenancy. |
| **3. Observability** | “Dashboards, alerts, status page” is still too vague; need SLOs and concrete signals (API, billing, tenancy); status page without SLOs is marketing. | **Concrete signals and SLOs:** API p95/p99 per route, 5xx rate, rate-limit, queue/DB timeouts; billing webhook timings, dedup, replay, failure reasons; tenancy (noisy tenants, abuse). Status page with history + SLOs. See Phase 3 (expanded). |
| **4. Monolith** | “index &lt;300 lines” is a vanity metric; splitting files doesn’t reduce risk without routing boundaries, middleware, test ergonomics, canary/feature flags. | **Expanded scope:** Routing structure and handler boundaries; shared middleware (auth, validation, errors); test ergonomics per module; deployment safety (feature flags, canary). See Phase 2 (expanded). |
| **5. CI gates** | “Fail on missing dashboard tests” is weak; need concrete, enforceable gates. | **Hard CI gates:** Grep fails if `dash-user`; grep/lint fails if `localStorage.setItem` touches key material; prod build fails if `VITE_API_BASE_URL` missing; dashboard must run ≥N tests (or coverage); security headers (CSP, HSTS) check on preview. See Part: Hard CI gates. |
| **6. Proof artifacts** | “Best-in-market” needs public proof: published SLOs, incident process + postmortems, security stance, data deletion + audit. | **Public proof artifacts:** Published SLO targets; incident process and postmortem template; security stance doc; data deletion guarantees and audit trail. See Part: Public proof artifacts. |

---

## Part 1c: Third Round — Last-Mile Execution Details (Competitor 8.6/10)

Competitor verdict: *“This is the kind of revision that changes the story. You’ve moved from good intentions to design decisions + acceptance criteria + enforcement. ~80% of the way to a real trust + ops proof moat. The remaining 20% is where teams usually stumble.”* We incorporate the following so the plan is **execution-proof**, not just design-complete.

| Area | What we add (this round) |
|------|---------------------------|
| **Key storage** | CSRF strategy for cookie-based sessions; session lifetime + refresh + idle/absolute max. |
| **Identity/tenancy** | Enforcement map table in IDENTITY_TENANCY.md; defined “no stale workspace” mechanism (401/403 → reselect + clear; optional subscribe/poll). |
| **Observability/SLOs** | Error budget + measurement window (e.g. 28-day rolling); **staged public SLOs** (Month 1: availability only; add latency once baseline exists); internal vs public targets. **CEO guardrail:** Don’t overclaim (e.g. 99.9%) until we have measured history. |
| **Monolith** | Request/response validation (Zod) and **consistent error taxonomy**; “no behavior change” contract (OpenAPI diff empty, golden tests stable, error codes stable). |
| **CI gates** | G2: **Ban** localStorage/sessionStorage.setItem in dashboard except allowlist (e.g. theme, workspace_id). G5: Run header check on **PR preview and staging**; add X-Content-Type-Options, Referrer-Policy, Permissions-Policy. |
| **Proof artifacts** | **Trust changelog** (security/ops improvements by date); **severity taxonomy (S0–S3)** for postmortem commitments. |
| **Remaining attack vectors** | Document and mitigate: retrieval quality until Phase 5; vector search latency predictability; abuse & cost containment (rate limits + per-tenant caps + anomaly alerts). |

---

## Part 1d: Fourth Round — Lock Session/CSRF, SLO Math, Trust Entry (Competitor 8.8/10)

Competitor verdict: *“What’s excellent scares a competitor. What’s still weak will bite you: session/token not fully specified; CSRF still ‘choose one’; SLO math not explicit; G4 gameable; Trust entry point open-ended.”* We lock the following so the plan is **unambiguous and execution-proof**.

| Area | What we lock (this round) |
|------|---------------------------|
| **Session/token** | **Dashboard Session Design** (subsection 0.2.6): endpoint names, token type, revocation triggers, re-auth behavior. No ambiguity. |
| **CSRF** | **Single approach** (no “or equivalent”): SameSite=Lax/Strict cookies + Origin/Referer validation + **CSRF token for mutating calls**. Document in SECURITY.md as the approach. |
| **API key UX** | “If you lose your key, you rotate”; grace-period rotation; clear warnings on reveal; API key metadata (created_at, last_used_at, last_ip). |
| **SLO math** | **Explicit definitions** (Appendix A): availability, latency p99, webhook processing — so status page isn’t negotiable. |
| **Phase 0 scope** | Phase 0 done **only when** G1–G5 green **and** session+CSRF implemented end-to-end; dashboard never handles long-lived keys; all mutating calls CSRF-protected. Anything not required to stop key leaks is deferred. |
| **G4** | Tests must include **auth/session**, **workspace scoping**, and **key flow** (or enforce coverage on specified modules). Not just “≥5 tests.” |
| **G5** | **HSTS optional**; focus on **CSP correctness**. |
| **Trust entry point** | **Exact location:** `docs/TRUST.md` (or `memorynode.ai/trust`) linking to SECURITY, INCIDENT_PROCESS, DATA_RETENTION, TRUST_CHANGELOG, SLOs. |
| **Definition of Done** | Each phase ends with a short **checklist** (5–10 bullets) so execution is readable. |

---

## Part 2: CEO Strategy — Becoming Best in Market

### 2.1 North star (6–12 months)

**MemoryNode.ai is the most trusted, operationally proven long-term memory layer for AI agents.**

- **Trust:** No key leaks, no demo auth, no random white screens. Security and reliability are table stakes we exceed.
- **Operational truth:** Status page, SLOs, clear incident playbooks. We show numbers; we don’t hide behind “beta.”
- **Differentiation:** Retrieval quality + tooling (eval, replay, explainability), not just “we have an API and PayU.”

### 2.2 Buyer readiness (what we prove and say)

| Buyer question | Evidence we build |
|----------------|-------------------|
| What pain does this remove today? | Clear value prop + “works in 5 minutes” flow; QUICKSTART and first-run UX. |
| How fast can I integrate? | SDK + one-command examples; optional “hosted + self-hosted” story. |
| Will it break my app at 3AM? | Status page, SLAs (or SLA targets), observability dashboards, runbooks. |
| Can I trust it with my users’ data? | No localStorage keys; RLS + audit; security page and compliance posture. |
| How do I debug retrieval quality? | Retrieval quality cockpit (Phase 5): eval sets, replay, explainability. |

### 2.3 Moat building (order of investment)

1. **Trust and safety** — Fix trust breakers (keys, auth, error boundary, tests). Without this, nothing else holds.
2. **Operational proof** — Real dashboards and alerts; status page; “we can answer in minutes.”
3. **API and code quality** — Single Env, 405, Worker split. Reduces outage risk and supports “modular, safe changes.”
4. **Retrieval quality cockpit** — Eval sets, replayable queries, “why this result.” This is the feature moat.
5. **Developer experience** — First 10 minutes, docs, optional self-hosted path.

### 2.4 Success metrics (CEO)

| Metric | Target | Owner |
|--------|--------|--------|
| First-run success rate | >90% (sign up → first memory → first search in &lt;10 min) | Product |
| Security posture (as shipped) | No keys in localStorage; no hardcoded demo auth; security review pass | CTO |
| Status page / SLO visibility | Public status; p95/p99 and error rate visible or committed | CTO |
| NPS / “would recommend” (devs) | Track and improve; “trusted” and “reliable” in top 3 words | CEO |
| Zero critical security incidents | No key leak, no “MemoryNode leaked my secrets” narrative | CTO |

**CEO guardrail — SLO overclaim:** Don’t publish aggressive SLO numbers (e.g. 99.9% availability) until we have **measured baseline history**. Publishing an SLO and breaching it early can hurt more than not publishing. We use **staged public SLOs**: start with availability only; add latency and others once we have data and tuning (see Phase 3 § 3.2).

---

## Part 3: CTO Execution — Phased Plan

Execution order is **trust first, then scale and observability, then differentiation.** Each phase has a clear “done” definition and must pass before we claim “production-ready” or “best-in-market” for that dimension.

**Cross-reference:** Where this plan overlaps with `docs/IMPROVEMENT_PLAN.md`, we follow the same technical tasks; this document adds **priority, gates, and success criteria** from the competitor review.

---

### Phase 0: Trust breakers (P0) — 2–3 weeks

**Goal:** Eliminate every item a competitor can use to say “we don’t leak your keys, we don’t ship demo auth, and our UI doesn’t randomly white-screen.”

#### 0.1 Identity and tenancy (not just “remove dash-user”)

Replacing `"dash-user"` is necessary but not sufficient. We need a **clear identity and tenancy story** so the UI is not “glued to the DB” without a clean model.

| # | Task | Detail | Done when |
|---|------|--------|-----------|
| 0.1.1 | Document identity model | **Auth:** Supabase Auth (email magic link + OAuth as today). **Mapping:** auth user id → workspace membership (via `workspace_members`) → API keys scoped to workspace. Document in SECURITY.md or a short `docs/IDENTITY_TENANCY.md`: how login → workspace list → current workspace → API key scope. | Single doc: auth provider, user → workspace → API key flow. |
| 0.1.2 | Implement real identity in MemoryView | Memory search (and any user-scoped or workspace-scoped call) uses **authenticated user id** and **current workspace id** from Supabase session + app state. No hardcoded `user_id`. Source: `supabase.auth.getUser()` (or session) + selected workspace. | MemoryView (and all similar views) use `user.id` and `currentWorkspaceId`; no `"dash-user"`. |
| 0.1.3 | User-removed-from-workspace behavior | Define and implement: when a user is removed from a workspace, (a) they lose access to that workspace’s keys/memories in the UI immediately (RLS already enforces server-side), (b) current workspace selection clears or switches to another they belong to, (c) no stale workspace id used for API calls. Document in IDENTITY_TENANCY or OPERATIONS. | Behavior implemented and documented; no use of workspace after removal. |
| 0.1.4 | Enforcement map in IDENTITY_TENANCY.md | Add a small **table** to `docs/IDENTITY_TENANCY.md` so implementation is unambiguous: \| **Source of truth** \| Supabase Auth user ID \|; \| **Workspace selection** \| Stored client-side (safe) as `workspace_id` only — not secret \|; \| **Authorization** \| Server verifies membership on every call \|; \| **API scope** \| `workspace_id` is mandatory for all dashboard calls; server rejects mismatches \|; \| **Revocation** \| Membership removal invalidates access immediately \|. | Table present in IDENTITY_TENANCY.md; code matches. |
| 0.1.5 | “No stale workspace” mechanism | Define and implement: **on 401/403** (membership or auth failure), UI **forces workspace reselect** and **clears cached workspace selection**; optionally **subscribe to membership changes** (or poll on page load) so removal is reflected without a failed call. Document in IDENTITY_TENANCY. | On 401/403 from membership, UI clears/reselects workspace; optional subscribe/poll documented. |

#### 0.2 Secure API key storage — chosen approach (no half-fix)

**Minimum acceptable approach for a devtools dashboard** (we commit to this; no “options” left open):

| # | Task | Detail | Done when |
|---|------|--------|-----------|
| 0.2.1 | No long-lived keys in browser | **Never** store long-lived API keys in the browser. localStorage, sessionStorage, and IndexedDB are all XSS-stealable. We remove any such storage. | No API key in localStorage/sessionStorage/IndexedDB. |
| 0.2.2 | Short-lived session tokens | Use **short-lived session tokens** (e.g. 15–60 min) minted by our backend (Worker or a small token-service route). Dashboard sends these in cookies or a dedicated header. Tokens are **httpOnly, Secure, SameSite** cookies so JS cannot read them. | Dashboard authenticates to API via session token in httpOnly cookie (or equivalent); token minted by our backend. |
| 0.2.3 | Create/reveal key flow | “Create API key” remains in UI/API. **One-time reveal** at creation: full key shown once, then never again. After that, display only **partial prefix** (e.g. `mn_xxxx…abcd`). Copy button only for prefix or “regenerate to get new key.” | Create key → one-time full reveal → thereafter only prefix in UI; no full key stored in front end. |
| 0.2.4 | Rotation and revoke | Support **rotation** (issue new key, optionally revoke old after grace period) and **revoke** in both UI and API. Document in API_REFERENCE and SECURITY.md. | Rotation and revoke available; documented. |
| 0.2.5 | CSP and XSS hardening | Add **Content-Security-Policy** (and other security headers) to the dashboard build/deploy. Restrict script sources, inline, and form actions. Basic XSS hardening (e.g. no `dangerouslySetInnerHTML` on user content without sanitization). In SECURITY.md, add **CSP exception process:** any CSP exception (e.g. `unsafe-inline`, wildcard) requires linked issue, reason, scope, and due date to remove — no open-ended exceptions. | CSP (and HSTS if applicable) set on dashboard; XSS guidance and CSP exception process in SECURITY. |
| **0.2 Add A** | **CSRF strategy (locked)** | We **pick one** approach; no “or equivalent.” **Chosen:** **SameSite=Lax** (or Strict) cookies **plus** **Origin/Referer validation** on the server **plus** **CSRF token for all mutating dashboard API calls** (double-submit cookie or server-generated token in header). **Allowed origins:** `https://<prod-dashboard-domain>` plus staging and preview pattern (e.g. `*.vercel.app` or your preview URL pattern). **Reject** missing Origin for browser requests; **allow** non-browser API clients (no Origin header) only on **non-dashboard** endpoints (e.g. programmatic API key calls). Document in SECURITY.md. | SECURITY.md states this as the approach; mutating calls enforce CSRF token + origin check; allowed-origins and browser vs API behavior defined. |
| **0.2 Add B** | **Session lifetime + refresh** | Define: **access token lifetime** (e.g. 15 min cookie); **refresh flow** (refresh token or Supabase session refresh) so users don’t get logged out mid-session; **idle timeout** (e.g. 30 min no activity → re-auth); **absolute max session** (e.g. 12 h). Without this, teams ship sessions that never expire or refresh unreliably. Document in SECURITY.md. | Session lifetime, refresh, idle timeout, and max session documented and implemented. |
| 0.2.7 | **API key UX (no compromise on security)** | **Docs/UX:** “If you lose your key, you rotate” — make **rotation painless** (one click + optional grace period). **Grace-period rotation:** old key valid for X hours (e.g. 24 h) after issue of new key, then invalid. **UI:** Clear **warnings** when revealing a key (one-time, copy once, don’t screenshot). **API key metadata** (expose in API/UI where appropriate): `created_at`, `last_used_at`, `last_ip` (if available) so users can spot misuse. | Rotation documented and easy; grace period optional; warnings on reveal; metadata in API/UI. |

#### 0.2.6 Dashboard Session Design (fully specified)

So Phase 0 doesn’t stall on “where does the session live?” we **lock** the following. Document in SECURITY.md (and optionally a short `docs/DASHBOARD_SESSION_DESIGN.md`).

| Item | Decision |
|------|----------|
| **Where** | Session endpoints live on the **Worker** (same API). No separate session service for Phase 0. |
| **Endpoints** | **Create/refresh:** `POST /v1/dashboard/session` (or `GET` for refresh with cookie). **Logout:** `POST /v1/dashboard/logout`. Request body or cookie carries Supabase auth (e.g. access token); Worker validates with Supabase, then issues dashboard session. |
| **Token type** | **Opaque session id** stored server-side with short TTL and workspace binding. Revocation and membership changes are immediate and easy. **JWT is explicitly out-of-scope for Phase 0** (if we switch later, it’s a post–Phase 0 optimization). Cookie name(s): e.g. `mn_dash_session` (access), optional `mn_dash_refresh` (refresh). **TTL:** Access e.g. 15 min; refresh (if used) e.g. 7 d. |
| **Session store (Phase 0)** | **DB-backed sessions (Postgres/Supabase).** One choice for Phase 0: store session rows in Postgres (e.g. existing Supabase DB). Consistent reads, clear membership invalidation, and simple join with workspace_members. KV is an option later for edge speed if we accept eventual-consistency tradeoffs; for Phase 0 we pick DB. |
| **Refresh cookie (if used)** | Refresh cookie must be **httpOnly, Secure, SameSite**. **Refresh tokens are rotated:** on each refresh, a **new** refresh token is issued and the **old one is invalidated**. Otherwise the refresh token becomes a long-lived secret. |
| **Authorization** | Opaque session id maps to **user_id** and **workspace_id** (current workspace at issue time). Server validates membership on every dashboard call; rejects if membership revoked. |
| **Revocation triggers** | Session invalidated on: **logout** (explicit call to logout); **membership removal** (user removed from workspace — invalidate sessions for that workspace or force reselect); **suspicious activity** (optional: e.g. IP change, many 401s); **manual admin revoke** (optional). Document which are in scope for Phase 0. |
| **Re-auth when refresh fails** | When refresh fails (expired, revoked, invalid): clear session cookie; redirect or return 401; dashboard shows login / “Session expired” and does **not** use cached credentials. No silent fallback. |
| **Session loss on deploy (Phase 0 default)** | **Tolerate session loss on deploy** (users re-auth). As long as deploy frequency is low and re-auth UX is clean, we avoid premature complexity. Phase 0 default: session loss on deploy is acceptable; users must re-auth (no broken states). Later (Phase 3/6) we can upgrade to zero session loss if customers demand it. |
| **Session store durability expectations** | Document so the session store doesn’t become an outage cause: **(2)** **Region / failover behavior** — Postgres/Supabase: what happens on failover; sessions in same DB as app data. **(3)** **Max session lookup latency target** — e.g. p95 &lt; 20 ms for session validation; alert if exceeded. Document in SECURITY.md or DASHBOARD_SESSION_DESIGN.md. |

**Implementation note:** Session tokens require the Worker to issue tokens after validating Supabase auth. Dashboard calls API with the session cookie; Worker maps token → user + workspace + scoped permissions. Architecture is documented in SECURITY.md and, if needed, DASHBOARD_SESSION_DESIGN.md.

#### 0.3–0.6 Other trust breakers

| # | Task | Detail | Done when |
|---|------|--------|-----------|
| 0.3 | Dashboard error boundary | React error boundary around main app content. On error: “Something went wrong” + Retry + Back. No white screen. | Any render throw is caught; user sees message + Retry/Back. |
| 0.4 | Dashboard tests (minimum) | At least: (1) smoke test that app mounts and key flows load, (2) test that memory search uses workspace/context (not hardcoded user_id), (3) test that no API key is read from localStorage (or key material from any browser storage). | CI runs dashboard tests; no regression on 0.1–0.3. |
| 0.5 | Remove localhost fallback in production | Dashboard `VITE_API_BASE_URL` must be **required** for production build. Build fails or app shows clear “Configure API URL” if missing. No silent fallback to `http://127.0.0.1:8787`. | Prod build or runtime refuses to use localhost when not in dev. |
| 0.6 | CI gates (concrete) | See **Part: Hard CI gates** below. Phase 0 implements and enforces them. | All hard gates in place and passing. |

**Scope guardrails:** Phase 0 is done **only when** G1–G5 are green **and** session + CSRF are implemented end-to-end. **Anything not required to stop key leaks and protect mutating calls is deferred** to a later phase (e.g. retrieval cockpit, extra UX polish).

**Phase 0 done when:** Identity/tenancy documented and implemented (0.1); secure key approach fully implemented (0.2), including **Dashboard Session Design (0.2.6)** and **CSRF (locked approach)**; error boundary, tests, no localhost fallback, and hard CI gates (0.3–0.6) complete; security review sign-off. **Phase 0 is not done unless the dashboard can operate without ever handling long-lived keys and all mutating calls are protected against CSRF.**

**Definition of Done — Phase 0:**
- [ ] IDENTITY_TENANCY.md exists with enforcement map and “no stale workspace” behavior.
- [ ] MemoryView (and similar) use real user + workspace; no `"dash-user"`.
- [ ] Dashboard Session Design (0.2.6) documented; create/refresh/logout endpoints implemented; **opaque session id** (JWT out-of-scope); cookie + TTL + revocation defined; **refresh cookie httpOnly/Secure/SameSite + rotation** (new refresh per refresh, old invalidated).
- [ ] No long-lived API keys in browser; session tokens only (httpOnly, Secure, SameSite); one-time key reveal + prefix thereafter.
- [ ] CSRF: SameSite + Origin/Referer + CSRF token for mutating calls; **allowed origins** (prod + staging + preview) and browser vs API behavior stated in SECURITY.md.
- [ ] Session lifetime, refresh, idle timeout, max session documented and implemented.
- [ ] Error boundary around main app; Retry/Back work.
- [ ] Dashboard tests include auth/session, workspace scoping, key flow (or coverage on App, apiClient, MemoryView); G1–G5 all green.
- [ ] Prod build requires VITE_API_BASE_URL; no localhost fallback in prod.
- [ ] Security review sign-off.

---

### Phase 1: API contract and config integrity — 1–2 weeks

**Goal:** Single source of truth for env; correct HTTP semantics; no config drift.

| # | Task | Detail | Done when |
|---|------|--------|-----------|
| 1.1 | Single `Env` type | `Env` defined only in `env.ts`; `index.ts` and all tests import it. No duplicate interface. | One `Env`; no duplicate definition. |
| 1.2 | 405 Method Not Allowed | Every known path returns 405 with correct `Allow` header for disallowed methods. Use same path list as in IMPROVEMENT_PLAN Phase 2.2. | All known routes return 405 + Allow when method wrong; tests cover 405. |
| 1.3 | Docs: PayU-only, no Stripe in gates | Complete IMPROVEMENT_PLAN Phase 1 (PayU in all docs; `check:docs-billing` in CI). | CI fails if Stripe required in billing docs. |

**Phase 1 done when:** Env single source; 405 everywhere; doc check in CI.

**Definition of Done — Phase 1:**
- [ ] `Env` defined only in `env.ts`; `index.ts` and tests import it.
- [ ] Every known route returns 405 with correct `Allow` for disallowed methods; tests cover 405.
- [ ] PayU-only in docs; `check:docs-billing` runs in CI and passes.

---

### Phase 2: Worker modularization — 2–4 weeks

**Goal:** Reduce outage and scaling risk. “index &lt;300 lines” alone is a vanity metric; we also improve **routing boundaries, shared middleware, test ergonomics, and deployment safety.**

| # | Task | Detail | Done when |
|---|------|--------|-----------|
| 2.1 | Router + handler modules | Implement IMPROVEMENT_PLAN Phase 4: `router.ts`, `handlers/*`, `auth.ts`, `cors.ts`, `audit.ts`, shared response/requestId helpers. index.ts becomes a thin fetch handler (&lt;~300 lines). | index.ts &lt;~300 lines; all handlers in modules. |
| 2.2 | Routing structure and handler boundaries | **Clear contract per route:** one handler per (path, method); no business logic in the router. Router only matches path/method and delegates. Handlers receive (request, env, context) and return Response. Document the routing table (path → allowed methods → handler) in code or a single config. | Single place that defines path → method → handler; no logic in router. |
| 2.3 | Shared middleware patterns | **Centralize:** auth (API key + admin token), validation (body parsing + Zod where applicable), error formatting (consistent JSON + request_id). Handlers assume auth and validation are already applied where needed; middleware runs in a consistent order (e.g. CORS → body size → route → auth → rate limit → handler). | Auth, validation, and error handling are reusable middleware; order documented. |
| 2.4 | Test ergonomics per module | Each handler module (or route group) can be tested in isolation with injected env and request. No need to bootstrap the entire Worker for unit tests. Document how to run “handler-only” tests. | At least one handler (e.g. memories or search) has a test that does not spin up full Worker. |
| 2.5 | Deployment safety (feature flags / canary) | **Canary:** We already have canary env in wrangler; ensure canary deploy and validation are part of release runbook. **Optional:** feature flags (e.g. env var or Worker binding) to disable or enable specific routes or behaviors without deploy. Document in RELEASE_RUNBOOK. | Canary is required path before prod; optional flags documented. |
| 2.6 | Request/response validation + error taxonomy | **Validation:** Choose a single validator (Zod already in use); **require every handler** to validate request inputs (body, query, params). **Error taxonomy:** Emit **consistent error codes** in API responses so devtools clients can rely on them. Standard set: `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, `NOT_FOUND`, `RATE_LIMITED`, `INTERNAL`, `UPSTREAM_TIMEOUT`. Document in API_REFERENCE; use same codes in all handlers. | Every handler validates inputs; all errors use the taxonomy; API_REFERENCE lists codes. |
| 2.7 | “No behavior change” contract (Phase 2 refactor) | For the Phase 2 split, **guarantee** no external behavior change: (a) **OpenAPI diff must be empty** (no new/removed/changed endpoints or response shapes); (b) **Golden tests** for responses stay the same (or only expand); (c) **Error codes** remain stable (same code strings and HTTP status mapping). Enforce via CI: OpenAPI check, test suite, and optionally contract tests. | OpenAPI diff empty; golden tests green; error codes unchanged. |
| 2.8 | Refactor invariant | Same routes, status codes, JSON shapes, headers (CORS, x-request-id), auth and quota semantics. Full test suite green; smoke tests pass. | No behavior change; tests and smoke confirm. |

**Phase 2 done when:** Monolith split (2.1); routing and middleware clear (2.2–2.3); test ergonomics (2.4); canary/flags (2.5); validation + error taxonomy (2.6); no-behavior-change contract (2.7); invariant verified (2.8).

**Definition of Done — Phase 2:**
- [ ] index.ts &lt;~300 lines; all handlers in modules; router only matches and delegates.
- [ ] Auth, validation, error handling are shared middleware; order documented.
- [ ] At least one handler testable in isolation without full Worker.
- [ ] Canary in release path; optional feature flags documented.
- [ ] Every handler validates inputs; error taxonomy (INVALID_ARGUMENT, UNAUTHENTICATED, etc.) in use and in API_REFERENCE.
- [ ] OpenAPI diff empty; golden tests green; error codes unchanged.
- [ ] Full test suite and smoke pass.

---

### Phase 3: Observability that answers in minutes — 2–3 weeks

**Goal:** “Operationally proven” requires **concrete signals and SLOs**, not vague “dashboards and alerts.” A status page without SLOs is marketing; one with history and SLOs is credibility. We define and wire the following.

#### 3.1 Concrete signals we must be able to answer in minutes

**API:**
- p95 and p99 latency **per route** (or per route_group) for successful (2xx/3xx) requests
- **p99 latency for 5xx** separately (“time to fail”) — for on-call; not an SLO but in health view
- 5xx rate (and 4xx rate if useful) per route
- Rate-limit events (429) per tenant or per key; **429 rate per tenant** as operational KPI + alerts (Appendix A)
- Queue/backlog (if any) — e.g. deferred webhook count
- DB query timeouts and vector search p95 (from existing `db_rpc` / `search_request` events)

**Billing (PayU):**
- Webhook receive → verify → process → reconcile **timings** (latency between stages)
- Dedup hit rate (webhook_replayed / webhook_received)
- Replay success rate (when we reprocess deferred)
- Failure reasons (signature invalid, workspace not found, verify API failure) with counts

**Tenancy:**
- Top N noisy tenants (by request count, 429 count, or cap_exceeded)
- Abuse detection triggers (e.g. spike in 401/403 from one key, or burst of failed webhooks for one workspace) — at least documented and queryable

#### 3.2 SLO targets — measurement window, error budget, staged publishing

**Add A: Measurement window and error budget.**  
SLOs without a **window** and **error budget** are marketing. We define:

- **SLO measurement window:** e.g. **28-day rolling** (or monthly). Document in OBSERVABILITY.md.
- **Error budget policy:** What happens when we burn the budget (e.g. freeze non-essential releases, focus on reliability, communicate to users). Document in OPERATIONS or INCIDENT_PROCESS.

**Add B: Internal targets vs public SLOs.**  
Don’t publish aggressive numbers before we have **baseline data**. Internal targets can be stricter; **public SLOs start modest and improve**.

- **Month 1 (or first publish):** Publish **availability SLO only** (e.g. 99.5% or a number we can already meet with measured history). Do **not** publish 99.9% until we have measured history that supports it.
- **Month 2+:** Add **latency SLO** once we have tuned p99 and baseline (e.g. from health view). Then add webhook/deferred if needed.

**Example SLO table (adjust to measured baseline before publishing):**

| SLO | Internal target (example) | Public (publish only when baseline supports) | Measured from |
|-----|----------------------------|----------------------------------------------|---------------|
| API availability | 99.9% (excl. 4xx) | Start with 99.5%; raise after history | request_completed status &lt; 500; **28-day rolling** |
| API latency p99 | &lt; 2000 ms | Add in Month 2+ once tuned | request_completed.duration_ms |
| 5xx error rate | &lt; 0.1% | Tie to availability | request_completed |
| Webhook processing | 99% within 5 min | After baseline | webhook_verified → webhook_processed |
| Deferred queue | Alert if depth &gt; N | — | webhook_deferred minus webhook_reconciled |

**CEO guardrail:** If we publish an SLO and breach it early, it can hurt more than not publishing. We **measure first**, then **publish conservative**, then **tighten** as we prove reliability.

**Exact math:** See **Appendix A: SLO definitions** for unambiguous formulas (availability, latency p99, webhook processing). Status page and dashboards must use these definitions so SLOs are not negotiable.

#### 3.3 Implementation tasks

| # | Task | Detail | Done when |
|---|------|--------|-----------|
| 3.3.1 | Log pipeline to metrics | Logpush (or equivalent) → log sink. Saved queries or dashboard definitions for every signal in § 3.1. Document exact queries or export dashboard JSON. | Every signal in 3.1 is queryable in &lt;5 min. |
| 3.3.2 | Health view dashboard | One dashboard: “Is the API healthy?” — error rate, latency p99, webhook failures, deferred count. Paging thresholds from ALERTS.md. | On-call can open health view in &lt;2 min. |
| 3.3.3 | Alerts wired | Alert rules for SLO breaches and anomaly conditions (e.g. 5xx spike, webhook failure spike, deferred queue depth). Test in staging. | Alerts fire when thresholds breached. |
| 3.3.4 | Public status page with SLOs and history | **status.memorynode.ai** (or equivalent): current operational status **and** SLO summary. Use **staged publishing** (§ 3.2): start with availability only; add latency etc. once baseline supports. **History** of incidents or SLO breaches (even if rare) so “we had 2 incidents in 6 months” is visible. | Status page live; SLOs per staged approach; history visible; linked from docs. |
| 3.3.5 | Error budget and window documented | Document in OBSERVABILITY.md: **measurement window** (e.g. 28-day rolling) and **error budget policy** (what we do when we burn the budget). | OBSERVABILITY.md updated; error budget policy in OPERATIONS or INCIDENT_PROCESS. |

**Phase 3 done when:** All signals in § 3.1 are available; SLO targets and error budget/window in § 3.2 documented; health view and alerts wired; status page live with staged SLOs and history; error budget policy documented.

**Definition of Done — Phase 3:**
- [ ] Every signal in § 3.1 queryable in &lt;5 min; health view openable in &lt;2 min.
- [ ] SLO definitions (Appendix A) and measurement window (28-day rolling) in OBSERVABILITY.md.
- [ ] Error budget policy documented in OPERATIONS or INCIDENT_PROCESS.
- [ ] Alerts wired and tested in staging.
- [ ] Status page live with staged SLOs and incident history; linked from docs.

---

### Phase 4: Dashboard reliability and first 10 minutes — 1–2 weeks

**Goal:** Dashboard is not a “toy”; first-run experience is smooth and trustworthy.

| # | Task | Detail | Done when |
|---|------|--------|-----------|
| 4.1 | Load more / pagination | MemoryView uses API `total` and `has_more`; “Load more” disabled when no more results; show “X of Y” or “No more results” where appropriate. | IMPROVEMENT_PLAN Phase 3.1 done. |
| 4.2 | First-run flow | Document and streamline: sign up → set workspace → add API key (or get one) → ingest one memory → run one search. QUICKSTART and in-app hints. | First-run success rate measurable; flow documented. |
| 4.3 | No confusing errors | 405 and other API errors show clear, actionable messages in UI. No raw “METHOD_NOT_ALLOWED” without explanation. | User-facing copy for common errors; no localhost in prod. |
| 4.4 | Dashboard deployment | Decide and document: Cloudflare Pages / Vercel / other. Add config (e.g. `wrangler.toml` for Pages or `vercel.json`). PROD_SETUP_CHECKLIST and RELEASE_RUNBOOK include dashboard deploy step. | Dashboard has a defined production deploy path; docs updated. |

**Phase 4 done when:** Pagination correct; first-run flow documented and smooth; dashboard deploy path documented and used.

**Definition of Done — Phase 4:**
- [ ] MemoryView uses API `total` and `has_more`; Load more disabled when no more results.
- [ ] First-run flow (sign up → workspace → key → memory → search) documented and measurable.
- [ ] User-facing error copy for common API errors; no localhost in prod.
- [ ] Dashboard deploy path (e.g. Cloudflare Pages/Vercel) and config documented; PROD_SETUP_CHECKLIST and RELEASE_RUNBOOK updated.

---

### Phase 5: Retrieval quality cockpit (moat) — 4–6 weeks

**Goal:** Differentiation: “How do I debug retrieval quality?” — we have the answer. Neutralize competitor’s “retrieval quality cockpit” attack.

| # | Task | Detail | Done when |
|---|------|--------|-----------|
| 5.1 | Evaluation sets | Allow users to define small “eval sets”: (query, expected or preferred memory ids). Store in DB; API or dashboard to run eval. | Eval sets CRUD; at least one “run eval” path (API or dashboard). |
| 5.2 | Replayable queries | User can re-run a past query (same query + params) and compare results. Optional: store query history per workspace. | Replay exists; results comparable (e.g. side-by-side or diff). |
| 5.3 | Explainability / “why this result” | For a given search result, show why it matched: e.g. vector score, text match snippet, metadata match. Surfaces in API response and/or dashboard. | At least one “explain” view or API field for a result. |
| 5.4 | Embedding/model visibility | Document or expose which embedding model/version is used. Optional: version in API response or dashboard. | Clear doc or UI for model/version; no “black box.” |

**Phase 5 done when:** Eval + replay + explainability available; documented in API_REFERENCE and dashboard; one end-to-end demo flow.

**Definition of Done — Phase 5:**
- [ ] Eval sets CRUD; at least one “run eval” path (API or dashboard).
- [ ] Replayable queries; results comparable (e.g. side-by-side or diff).
- [ ] At least one “explain” view or API field for a search result.
- [ ] Embedding/model version documented or exposed in API/UI.
- [ ] One end-to-end demo flow documented.

---

### Phase 6: Test quality and DX — ongoing, 1–2 weeks focused

**Goal:** Tests are type-safe and maintainable; Stripe is gone; runbooks match code; quickstart is copy-paste friendly.

| # | Task | Detail | Done when |
|---|------|--------|-----------|
| 6.1 | Typed mocks; no Stripe in Vitest | IMPROVEMENT_PLAN Phase 7.1: MockEnv/MockSupabase; replace `any`; remove Stripe from vitest.setup. | No Stripe in test setup; typed mocks in use. |
| 6.2 | Runbook consistency | One pass over RELEASE_RUNBOOK, PROD_SETUP_CHECKLIST, BILLING_RUNBOOK, OPERATIONS: every env var and command matches code. | Runbooks match code; no leftover Stripe. |
| 6.3 | Quickstart | Single copy-paste path in README/QUICKSTART: clone, install, env, migrate, dev, one curl/SDK example. Optional: local Supabase script or docker-compose. | New dev can go from zero to “one memory + one search” in &lt;15 min. |

**Phase 6 done when:** Tests typed; runbooks aligned; quickstart verified.

**Definition of Done — Phase 6:**
- [ ] Typed mocks in use; no Stripe in vitest.setup.
- [ ] RELEASE_RUNBOOK, PROD_SETUP_CHECKLIST, BILLING_RUNBOOK, OPERATIONS match code.
- [ ] README/QUICKSTART: single copy-paste path to “one memory + one search” in &lt;15 min.

---

## Part 3b: Hard CI gates (concrete and enforceable)

“Fail on missing dashboard tests” and “grep for bad patterns” are only useful if they are **concrete and enforced**. Below are the gates we implement; CI must fail when any of these are violated.

| Gate | Rule | How to enforce | Owner |
|------|------|-----------------|--------|
| **G1** | No `dash-user` in dashboard (or API called by dashboard) | Grep: fail if `"dash-user"` or `'dash-user'` appears in `apps/dashboard/` (and optionally `apps/api/` if API ever sent it). | CI step: `rg "dash-user" apps/dashboard && exit 1` (or equivalent). |
| **G2** | No key material in browser storage | **Do not** try to detect “key material” by string match only (brittle). **Simplest:** **ban** any use of `localStorage.setItem(` and `sessionStorage.setItem(` in the dashboard **entirely**, except for an **allowlist** of safe keys (e.g. `theme`, `workspace_id`). CI fails if any other key is written. If we must allow more later, maintain an explicit allowlist (e.g. `["theme", "workspace_id"]`) and enforce in script or lint. | CI: script that greps for localStorage/sessionStorage.setItem; allowlist only theme, workspace_id (or doc-defined list); exit 1 on any other. |
| **G3** | Production build requires API URL | For **production** dashboard build, fail if `VITE_API_BASE_URL` is missing or is localhost. Use build-time check in vite config or a post-build script. | CI: run prod build with env check; fail if `VITE_API_BASE_URL` unset or `http://127.0.0.1` when `NODE_ENV=production` or similar. |
| **G4** | Dashboard test minimum (not gameable) | Dashboard tests must include **at least one test each for:** **(a)** auth/session flow, **(b)** workspace scoping (e.g. memory search uses workspace context, not hardcoded user), **(c)** key create/reveal flow (or equivalent). **Alternatively** enforce minimum coverage on specified modules (e.g. App, apiClient, MemoryView). CI fails if these categories are missing or coverage is below threshold. “≥5 tests” alone is not sufficient. | CI: run dashboard tests; assert presence of tests for auth/session, workspace scoping, key flow (or enforce coverage on listed modules); exit 1 if not met. |
| **G5** | Security headers on PR preview **and** staging | Run against **(1) PR preview** and **(2) staging after merge**. Check: **CSP** present and **not obviously useless** — fail if CSP contains `unsafe-inline` for scripts (unless we explicitly document a justified exception), or `*` wildcard on `script-src`. **X-Content-Type-Options: nosniff**; **Referrer-Policy**; **Permissions-Policy** (even minimal). **HSTS** is optional; focus on **CSP correctness**. Fail if CSP or required headers missing or CSP is permissive in the above sense. **CSP exception process:** Any CSP exception (e.g. `unsafe-inline` or wildcard) requires: **linked issue**, **reason**, **scope**, and a **due date to remove**. Document in SECURITY.md (or gate doc); no open-ended exceptions. | CI: deploy preview + staging → curl headers → assert CSP (and CSP must not be permissive: no unsafe-inline for scripts, no * on script-src unless doc-excepted), X-Content-Type-Options, Referrer-Policy, Permissions-Policy; exit 1 if missing or CSP fails check. |

**Implementation:** Add a small script (e.g. `scripts/ci_trust_gates.mjs` or steps in `.github/workflows/ci.yml`) that runs G1–G5. Document in PRE_PUSH_CHECKLIST and in this plan. Phase 0 is not “done” until G1–G5 are in CI and passing.

---

## Part 3c: Public proof artifacts (for “best-in-market” claim)

To credibly say “most trusted, operationally proven,” we need **public proof points**. Without them, it’s positioning only.

| Artifact | What we publish | Where |
|----------|-----------------|--------|
| **SLO targets** | Latency p95/p99, availability, error rate, webhook processing (see Phase 3 § 3.2). Staged: start with availability; add latency once baseline exists. | OBSERVABILITY.md; status page. |
| **Incident process + postmortems** | Short public doc: how we detect, triage, communicate, and resolve incidents. **Severity taxonomy (S0–S3)** defined clearly so postmortem commitments are unambiguous (e.g. S0 = full outage; S1 = major degradation; S2 = partial; S3 = minor). Commitment: postmortem for severity ≥ S2 (or all outages). Template: what happened, impact, root cause, action items. | docs/INCIDENT_PROCESS.md; link from status page or main docs. Postmortems: internal first; optionally sanitized public summary. |
| **Security stance** | What we do (auth, RLS, no long-lived keys in browser, audit logging, secret rotation) and what we don’t (e.g. we don’t store raw API keys in dashboard). Data handling: where it lives, who can access, how long. | docs/SECURITY.md (expand) or public “Security” / “Trust” page. |
| **Data deletion and audit trail** | How users can delete their data (or request deletion). That we have an audit trail (api_audit_log, billing events) and retention policy. | docs/SECURITY.md or docs/DATA_RETENTION.md; link from dashboard or signup. |
| **Trust changelog** | A **small public page** (or doc section) that lists **security and ops improvements by date** (e.g. “Session tokens moved to httpOnly cookies”, “CSP added”, “SLO dashboard live”). Creates momentum and signals seriousness. Update on each meaningful trust/ops release. | e.g. memorynode.ai/trust/changelog or docs/TRUST_CHANGELOG.md; linked from Trust entry point. |

**Trust entry point (exact location):** **`docs/TRUST.md`** (in repo) or **`memorynode.ai/trust`** (website). That page links to: SECURITY.md, INCIDENT_PROCESS.md, DATA_RETENTION.md (or equivalent), TRUST_CHANGELOG.md, and SLOs (OBSERVABILITY.md or status page). No ambiguity: one canonical URL or path.

**Done when:** All five artifacts are in place; **severity taxonomy (S0–S3)** is defined in INCIDENT_PROCESS; all linked from the Trust entry point above. Required before we use “best-in-market” in external positioning.

---

## Part 3d: Remaining attack vectors (competitor will still push here)

Even after this plan, a competitor would still attack on:

| Vector | Risk | Our mitigation |
|--------|------|----------------|
| **Retrieval quality tooling** | Most memory layers fail because “results feel wrong,” not uptime. Until Phase 5 ships, we’re exposed. | Don’t delay Phase 5 (retrieval cockpit). Prioritize eval + replay + explainability once trust and ops are solid. |
| **Latency predictability on vector search** | Supabase/pgvector can be great, but p99 can drift under load without index/tuning and query complexity caps. | Observability (Phase 3) + noisy-tenant metrics; tune indexes and cap query complexity; document in PERFORMANCE.md. |
| **Abuse and cost containment** | If we’re “trusted,” attackers will test us. Rate limiting and per-tenant caps must be real. | Ensure **rate limiting** (60 rpm default; 15 rpm new keys 24–48h) + **per-tenant caps** (usage_daily, plan limits — see [Plans & Limits](README.md#plans--limits)) + **anomaly alerts** ship alongside SLOs. Document in ALERTS and OPERATIONS. |

We acknowledge these in the plan so they are not forgotten; mitigation is either in scope (Phase 3, 5) or called out as operational requirements.

---

## Appendix A: SLO definitions (explicit math)

So the status page and internal dashboards are **not negotiable**, we define the following. Document in OBSERVABILITY.md and use the same definitions on the status page.

| SLO | Definition (exact) |
|-----|--------------------|
| **Availability** | `1 - (5xx_count / total_requests)` over the **28-day rolling** window. **Exclude** 4xx client errors from both numerator and denominator (i.e. availability = server success rate). **429 (rate-limited) is treated as 4xx** and excluded from this SLO. For a devtool, being rate-limited can still feel like downtime, so we add a **separate operational KPI:** **“429 rate per tenant”** with alerts; optionally an internal **“useful availability”** metric that includes 429 impact. |
| **Latency p99** | **p99** of `duration_ms` (or `latency_ms`) for **successful** requests (HTTP 2xx, and optionally 3xx) **per route_group**. Failed requests (4xx/5xx) are excluded from latency SLO. **Health view (on-call):** Also track **p99 latency for 5xx** separately (“time to fail”) so we know how long failures take; this is not an SLO but belongs in the health view. |
| **Webhook processing within 5 min** | **p99** of (processed_timestamp − verify_timestamp) for webhooks that reached “verified” state. **Exclude** webhooks that failed signature verification (invalid signature). Unit: seconds or minutes; threshold e.g. 300 s (5 min). |

**Window:** All SLOs above use a **28-day rolling** window unless otherwise stated. **Error budget:** Define in OPERATIONS or INCIDENT_PROCESS: e.g. “When budget is exhausted, we freeze non-essential releases and prioritize reliability.”

---

## Part 4: Execution Order and Gates

**Recommended sequence:**

1. **Phase 0 (Trust breakers)** — Must complete before any “production-ready” or “trusted” claim. Blocks marketing and sales narrative.
2. **Phase 1 (API + config)** — Unblocks clean refactor and prevents config drift.
3. **Phase 2 (Worker split)** — Reduces outage risk and supports scaling.
4. **Phase 3 (Observability)** — Required to “answer in minutes” and run status/SLOs.
5. **Phase 4 (Dashboard + first 10 min)** — Completes trust and first-run story.
6. **Phase 5 (Retrieval cockpit)** — Moat; can start in parallel after Phase 2.
7. **Phase 6 (Tests + DX)** — Can run in parallel; complete before “best-in-market” claim.

**CI must gate (concrete):**

- **Hard CI gates G1–G5** (Part 3b): dash-user grep, no key material in localStorage, prod build requires VITE_API_BASE_URL, dashboard test minimum, security headers on preview.
- Doc billing check (Phase 1).
- Full test suite + smoke (all phases).
- Optional: OpenAPI drift check (already in place).

**Go/no-go for “production-ready”:** Phases 0, 1, 2, 3, 4 complete; Phase 6 runbooks and quickstart done; G1–G5 in CI and passing.

**Go/no-go for “best-in-market” narrative:** Above + Phase 5 (retrieval cockpit); Phase 6 (typed tests, runbooks); status page with SLOs and history (Phase 3); **public proof artifacts** (Part 3c) published and linked.

---

## Part 5: One-Page Summary (CEO + CTO)

| Priority | What | Why |
|----------|------|-----|
| **P0** | Fix trust breakers (no demo auth, no keys in localStorage, error boundary, dashboard tests, CI gates) | Competitor: “We don’t leak your keys, we don’t ship demo auth, our UI doesn’t white-screen.” We eliminate that narrative. |
| **P1** | Single Env + 405 + Worker split | Config drift and monolith = “works in staging but not prod” and outage risk. |
| **P2** | Observability in minutes (dashboards, alerts, status page) | “Operationally proven” vs “operability planned.” We prove. |
| **P3** | Dashboard reliability + first 10 minutes + deploy path | First 10 minutes decide developer tools. |
| **P4** | Retrieval quality cockpit (eval, replay, explainability) | Moat; answers “how do I debug retrieval?” |
| **P5** | Test quality + runbooks + quickstart | Long-term maintainability and “works in 5 minutes.” |
| **—** | **Hard CI gates (G1–G5)** | Enforceable gates: no dash-user, no key in localStorage, prod API URL required, dashboard test minimum, security headers on preview. |
| **—** | **Public proof artifacts** | Published SLOs, incident process + postmortems, security stance, data deletion + audit trail — required for “best-in-market” claim. |

**Target rating after execution:** 8+ overall (security as shipped 8+, frontend trust 8+, operational readiness 8+, business readiness 8+).

---

## Document control

- **Created:** 2026-02 (response to competitor CEO/CTO review).
- **Revision log:**
  - **Round 2:** Closed six gaps — key storage chosen approach, identity/tenancy, concrete observability/SLOs, monolith scope, hard CI gates, public proof artifacts.
  - **Round 3:** Last-mile execution — CSRF + session lifetime/refresh; identity enforcement map + “no stale workspace”; SLO error budget + window + staged publishing; request validation + error taxonomy + no-behavior-change contract; G2 allowlist, G5 PR+staging + headers; Trust changelog + severity S0–S3; remaining attack vectors. Rating: 8.6/10.
  - **Round 4:** Lock session/token (Dashboard Session Design 0.2.6), CSRF single approach (SameSite + Origin/Referer + CSRF token), API key UX (rotation, grace period, warnings, metadata); SLO definitions appendix (explicit math); Phase 0 scope guardrails + “not done unless no long-lived keys + CSRF”; G4 auth/workspace/key tests (not gameable); G5 HSTS optional; Trust entry point `docs/TRUST.md` or `memorynode.ai/trust`; Definition of Done checklist per phase. Rating: 8.8/10.
  - **Clarifications:** Token type = opaque only (JWT out-of-scope Phase 0); refresh cookie httpOnly + rotation (new per refresh, old invalidated); availability SLO explicit 429 = 4xx + 429-rate-per-tenant KPI/alerts; latency health view includes p99 for 5xx (“time to fail”); Origin/Referer = allowed origins (prod + staging + preview), reject missing for browser, allow non-browser on non-dashboard; G5 CSP must not be permissive (no unsafe-inline for scripts, no * on script-src unless doc-excepted).
- **Owners:** CEO (strategy, buyer readiness, moat order, proof artifacts, SLO overclaim guardrail); CTO (execution, phases, gates, observability)
- **Related:** `docs/README.md#plans--limits` (Plans & Limits); `docs/IMPROVEMENT_PLAN.md`; `docs/PROD_SETUP_CHECKLIST.md`; `docs/OBSERVABILITY.md`; `docs/ALERTS.md`; `docs/SECURITY.md`; `docs/IDENTITY_TENANCY.md`; `docs/TRUST.md` (Trust entry point); `docs/DASHBOARD_SESSION_DESIGN.md` (optional)
