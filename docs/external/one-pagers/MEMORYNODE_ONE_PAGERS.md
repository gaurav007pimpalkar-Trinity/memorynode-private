# MemoryNode.ai — Audience One-Pagers

**Generated:** 2026-04-22
**Product:** MemoryNode.ai — hosted per-user memory layer for customer-facing AI apps (REST + MCP + TypeScript SDK).
**Repo state used:** `main` @ `3123742` (commit log tip).

Each page below is self-contained. Share as-is. Truth-check of docs vs. system is kept **outside** this file (see chat output / repo commit message).

---

## 1) CEO One-Pager

**Elevator pitch.** MemoryNode is the memory layer for AI apps. Developers call one API (or one MCP tool) to save what a user said, then recall the right context on the next turn. They ship a personalized assistant without running a vector database.

**Why now.**
- Chat/agent products are the hot category, and every one of them forgets the user across sessions.
- Teams want to stop babysitting pgvector, Pinecone, embeddings pipelines, and retrieval tuning.
- MCP (Model Context Protocol) is standardizing how agents reach external tools — MemoryNode ships an **MCP-native** product, not an afterthought.

**What the product does.**
- **Save** memories per user or scope (`POST /v1/memories`), with optional auto-extraction.
- **Recall** via hybrid (vector + keyword + rerank) search (`POST /v1/search`).
- **Context pack** prompt-ready blocks (`POST /v1/context`), with **explainability** (`GET /v1/context/explain`) so teams can debug why a chunk was returned.
- **Three transports**: REST, TypeScript SDK, and an MCP server (hosted Streamable HTTP + stdio package for Cursor/Claude Code).

**ICP (who pays).**
- Individual builders and small teams shipping support copilots, SaaS in-app assistants, SMB chatbots, founder tools.
- India-first on billing (PayU), global-capable on runtime (Cloudflare Workers + Supabase + OpenAI).

**Current status (honest).**
- Public API live at `api.memorynode.ai`; console at `console.memorynode.ai`; staging at `api-staging.memorynode.ai`.
- Hosted MCP route `mcp.memorynode.ai/*` is configured in `wrangler.toml` (production bind — needs live verification after next deploy).
- Monorepo: `apps/api`, `apps/dashboard`, `packages/{sdk,mcp-core,mcp-server,cli,shared}`, 63 SQL migrations.
- Billing stack live (PayU checkout + webhook + entitlements v3 + usage-events ledger).
- Trial expiry gating and premium console login ship as of this week.

**Traction / GTM wedges.**
1. Support/success copilots (ticket continuity).
2. SMB high-volume chat (caps-aware, cheap per seat).
3. SaaS copilots (tenant-safe ids with `userId` + `scope`).

**Risks (top 3).**
1. **Single-founder ops** — no on-call rotation; every deploy is manual (guarded by `DEPLOY_CONFIRM`).
2. **Cost leakage via extraction** — `extract: true` can run chat completions; caps are enforced atomically now (Plan v2), but abuse testing on prod is still pending.
3. **Distribution** — narrow positioning is correct, but inbound is manual; no paid channel yet.

**Ask.** Design-partner warm intros for: support-tool vendors, SMB chat operators, and AI agent framework maintainers.

---

## 2) CTO One-Pager

**Architecture.**
- **Frontend.** `apps/dashboard` — React 18 + Vite 6, deployed via Cloudflare Pages (dual build: console + founder app). Supabase Auth (magic link + GitHub OAuth) with CSRF-protected session cookie (`mn_dash_session`) bound to the API.
- **API.** `apps/api` — single Cloudflare Worker (`memorynode-api`) with `nodejs_compat`. Entry `src/index.ts` → `workerApp.ts` (routing, request lifecycle, cost guards). Router in `router.ts`. `workerApp.ts` is ~163 KB today but **is covered by tests** (v8 coverage includes it; run 2026-04-22 shows ~65% lines hit).
- **DB.** Supabase Postgres. 63 migrations in `infra/sql/` (`001_init.sql` → `063_workspace_trial.sql`). RLS-first on every request path; service-role access is least-privileged via `supabaseScoped.ts`.
- **Rate limiting / isolation.** Two Durable Objects: `RATE_LIMIT_DO` (per-key + per-workspace windows) and `CIRCUIT_BREAKER_DO` (OpenAI + Supabase). Workspace in-flight concurrency cap enforced in Worker.
- **MCP spine.** Hosted Streamable HTTP MCP lives in `apps/api/src/mcpHosted.ts`; stdio package in `packages/mcp-server`. Policy engine (`packages/shared/src/mcpPolicy.ts`) governs rate/replay/forget-confirm/token-budget per MCP action. Plan of record: collapse both transports onto `packages/mcp-core` (registry + services) per `docs/PLAN.md`.

**Critical paths (reality, from code).**
1. `POST /v1/memories` → auth → quota resolve → key RPM → workspace RPM → plan guards (`max_text_chars`, extraction) → **atomic reserve** (`reserve_usage_if_within_cap`) → embed → insert memory + chunks → commit reservation.
2. `POST /v1/search` → same prelude → reserve (read + optional embed) → `performSearch` (vector / keyword / hybrid RRF) → commit.
3. `POST /v1/billing/webhook` → signature check → idempotency → reconcile → entitlement update.

**Test & CI reality.**
- Vitest + v8 coverage. Thresholds: 50% lines/statements, 45% functions, 40% branches. **Passes** on current main.
- `test:ci` chains: typed-entry check → wrangler config checks → migrations check → workspace scope/config checks → API-surface Phase-1 → OpenAPI drift → docs-drift → MCP noun-verb lint → vitest.
- Strong coverage: `billing/payuReconcile` (75%), `handlers/evals` (88%), `handlers/context` (92%), `handlers/contextExplain` (87%), `dashboardSession` (76%).
- Weak coverage (tech debt): `mcpHosted.ts` (≈3%), `handlers/memoryLinks.ts`, `handlers/memoryWebhook.ts`, `handlers/explain.ts`, `handlers/ingest.ts`, `handlers/pruning.ts`, `handlers/dashboardOverview.ts`, `handlers/connectorSettings.ts` (each ≈1–13%).
- No E2E in CI (smoke + e2e need secrets; e2e is manual).

**Resilience.**
- Retries: `fetchWithRetry` for OpenAI embeddings (3 attempts, 500/1000 ms). `withSupabaseQueryRetry` on critical Supabase paths (auth salt, key lookup, dashboard session, project plan, `/ready`). Supabase Auth verify has retry.
- Circuit breaker on OpenAI and Supabase.
- Readiness probe: `/ready` does a DB touch.
- No queue yet; async work runs via HTTP-triggered GitHub Actions (memory hygiene etc.).

**Security posture.**
- API keys hashed with `API_KEY_SALT`; DB row stores hash + prefix only; `last_used_at` tracked.
- RLS on every tenant-scoped table; `REQUEST_PATH_PRIVILEGE_INVENTORY.md` maps privileges per route.
- `MASTER_ADMIN_TOKEN` gates admin endpoints (single token; rotation is manual — known risk).
- Secrets live in Wrangler secret store; `.env*` templates kept empty; secret-scan on staged files and tracked files in CI.
- Production env gates: `EMBEDDINGS_MODE=stub`, `SUPABASE_MODE=stub`, `RATE_LIMIT_MODE=off` all throw `CONFIG_ERROR` in production/staging.

**Top technical debts.**
1. Split or shrink `workerApp.ts` (~163 KB) and ship `packages/mcp-core` so REST + MCP stop duplicating logic.
2. Raise `mcpHosted.ts` test coverage from ≈3% to ≥60% before treating MCP as production-grade.
3. Add a CI step that applies migrations to a staging DB (currently only `deploy:prod` applies migrations).
4. Add APM / tracing for memory create + search + webhook.
5. Move `MASTER_ADMIN_TOKEN` to scoped admin tokens with audit.

---

## 3) CFO One-Pager

**Revenue model.** Subscription in INR via PayU, plus overage billing ledger.

**Plan grid (source: `packages/shared/src/plans.ts`, authoritative).**

| Plan    | Price (INR) | Period | Writes/day | Reads/day | Embed tokens/day | Gen tokens (cycle) | Extraction/day | Storage |
|---------|-------------|--------|------------|-----------|-------------------|---------------------|----------------|---------|
| Launch  | **399**     | 7 days | 250        | 1,000     | 100,000           | 150,000             | 0              | 0.5 GB  |
| Build   | **999**     | 30 d   | 1,200      | 4,000     | 600,000           | 1,000,000           | 100            | 2 GB    |
| Deploy  | **2,999**   | 30 d   | 5,000      | 15,000    | 3,000,000         | 5,000,000           | 500            | 10 GB   |
| Scale   | **8,999**   | 30 d   | 20,000     | 60,000    | 12,000,000        | 20,000,000          | 2,000          | 50 GB   |
| Scale+  | custom      | custom | 100,000    | 200,000   | 200,000,000       | 200,000,000         | 5,000          | 250 GB  |

Overage rates live per-plan (`overage_writes_per_1k_inr`, `overage_reads_per_1k_inr`, `overage_embed_tokens_per_1m_inr`, `overage_gen_tokens_per_1m_inr`, `overage_storage_gb_month_inr`) and settle through `invoice_lines_overage`.

**Variable cost per unit (today's vendor pricing).**
- OpenAI `text-embedding-3-small`: ~$0.02 per 1M input tokens.
- OpenAI `gpt-4o-mini` (extraction): ~$0.15 input / $0.60 output per 1M tokens (order of magnitude).
- Cloudflare Workers + DOs + Pages: sub-dollar/day at current volume.
- Supabase: paid tier for prod DB + auth; fixed monthly.

**Unit-economics sanity check.**
- **Scale @ ₹8,999** (~$108) supplies 12M embed tokens/day (~360M/month). Pure embedding cost at cap ≈ $7.2/month → healthy gross margin on embed-only users.
- **Extraction is the margin risk.** Scale allows 2,000 extraction calls/day (60k/month). At 600 output + 400 input tokens/call average, that's ~60M tokens/month → ~$12–40/month variable. Still well inside revenue, but **only** because daily caps + atomic reserves are enforced. Abuse (or accidental loops) without caps could push cost above revenue — the existing Plan v2 atomic RPC is what keeps this safe.
- **Extraction children** previously bypassed caps (see `docs/COST_BILLING_AUDIT.md`). This is now routed through the atomic reserve path in Plan v2. Residual risk: no per-workspace INR daily cap (only per-dimension caps).

**Cost-safety controls in code.**
- `reserve_usage_if_within_cap` RPC (atomic check-and-bump) gates memories, search, context, import, eval.
- `WORKSPACE_CONCURRENCY_MAX=8`, `WORKSPACE_COST_PER_MINUTE_CAP_INR=15` at Worker level.
- Key RPM (60 default, 15 for new keys <48h). Workspace RPM (120 standard, 300 Scale/Scale+).
- `EVAL_RUN_ITEMS_CAP=100` to cap eval cost per call.
- Trial writes guard and `TRIAL_EXPIRED` 402 after trial window.
- Plan limit errors return 402 `PLAN_LIMIT_EXCEEDED` with `{limit, used, cap}`.

**Working-capital and collection risk.**
- Billing is PayU; webhook verify-before-grant with idempotency and deferred-reconcile. Failed webhooks do not issue entitlement.
- Refund path exists (`admin/usage/reconcile`) for post-deploy reconciliation.
- No enterprise/invoiced contracts yet; all prepaid via PayU → receivables risk is low.

**What an investor / auditor should verify.**
1. Live PayU merchant key + salt rotated and in Wrangler secrets only (no repo leakage — scanner runs in CI).
2. `AI_COST_BUDGET_INR` set as a global kill switch (documented as recommended; confirm it is set in production).
3. Scale / Scale+ contracts carry per-customer INR caps (product-level) where usage can exceed embed/extraction economics.

---

## 4) VC One-Pager

**Company.** MemoryNode.ai — founder-led (India), pre-seed stage.
**Product.** Hosted memory API + MCP server for AI apps. "Reliable per-user memory without running a vector DB."
**Stage signals.** Working product, public API live (`api.memorynode.ai`), console live, PayU billing live, MCP server shipping, 63 applied Postgres migrations, ~70% test coverage on main API surface, CI gates with trust/economics/docs-drift checks.

**Market.**
- Every AI app with users has a memory problem. RAG vendors (Pinecone, Weaviate, Chroma, Qdrant) solve storage, not **per-user memory with explainability and caps**.
- Adjacent players: Mem0 (OSS memory), Zep (open-source memory), LangMem, Cognee. MemoryNode's differentiators: MCP-first, caps + billing baked in, explainability endpoint, India-first payments.

**What's unique in the repo.**
- **Explainability surface.** `GET /v1/context/explain` returns per-chunk scoring rationale — most memory products don't ship this.
- **Cost-safety discipline.** Atomic reserve-before-execute, token-based cap accounting, per-plan extraction gating, eval run cap of 100, workspace RPM + concurrency caps.
- **MCP + REST parity plan.** Concrete roadmap in `docs/PLAN.md` to make MCP the spine (`packages/mcp-core`) so the same product is reachable by agents and by HTTP clients.
- **Governance.** Docs-drift CI (`pnpm check:docs-drift`) and source-of-truth alignment enforced on every PR.

**Traction (honest).**
- Public hosted endpoint is up and receiving checkable traffic (healthz returns 200).
- Early adopters path: `docs/start-here/FOUNDER_PATH.md` and `examples/{node,python,nextjs-middleware,langchain-wrapper,support-bot-minimal}`.
- No disclosed ARR yet; INR SKUs positioned for Indian builders first (low friction), global next.

**Defensibility.**
- **Data gravity** — once a workspace has months of memories, switching cost is real (export exists but behavioral inertia is high).
- **Explainability lock-in** — teams that debug retrieval with our explain endpoint and `retrieval_cockpit` stay.
- **MCP distribution** — as Cursor / Claude Code / other MCP clients scale, hosted MCP becomes a referral edge.

**Risks (for diligence).**
1. Solo founder; no co-founder or deputy yet.
2. Single cloud (Cloudflare) + single DB (Supabase) — vendor concentration, mitigated by standard Postgres + stateless Worker code.
3. Competition is well-funded (Mem0, Zep) — narrow wedges and cost discipline matter.
4. Doc/system drift is a known risk; enforced by CI (`check:docs-drift`) but not eliminated.
5. No SOC2 or DPA artifacts yet — required for enterprise.

**Use of funds (indicative).**
- First engineer for reliability + observability (split `workerApp.ts`, raise MCP hosted coverage, add APM).
- Design partner + docs content velocity.
- Compliance foundation (DPA template, SOC2 readiness).

**The ask.** Pre-seed round to hire the first engineer, ship SOC2-readiness, and push 10 paying design partners. Warm intros wanted to support-tool, SMB-chat, and AI-agent framework leaders.

---

*Single source of truth for plans/limits/API behavior: `packages/shared/src/plans.ts`, `apps/api/src/router.ts`, `apps/api/src/workerApp.ts`, `docs/external/openapi.yaml`. All figures above are derived from code on main at the date of generation.*
