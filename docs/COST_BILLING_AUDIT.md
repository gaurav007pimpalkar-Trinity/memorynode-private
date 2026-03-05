# Cost & Billing Audit — CTO-Level Report

**Date:** 2025-03-05  
**Scope:** Entire repository — limits, cost-generating operations, retries, enforcement order, bypass paths, plan safety.

---

## 1. BILLING LIMITS

### 1.1 Plan limits (source of truth)

| File | What | Limit | Enforcement | Hard / Soft |
|------|------|--------|-------------|-------------|
| `packages/shared/src/plans.ts` | Plan definitions | `writes_per_day`, `reads_per_day`, `embed_tokens_per_day`, `extraction_calls_per_day`, `max_text_chars`, `workspace_rpm` per plan (Launch/Build/Deploy/Scale/Scale+) | Used by API via `getLimitsForPlanCode`; enforced in handlers via `reserveQuotaAndMaybeRespond` → `bump_usage_if_within_cap` | **Hard** (atomic RPC) for all except extraction children (see §5) |
| `packages/shared/src/plans.ts` | `embedsCapFromEmbedTokens` | `floor(embed_tokens_per_day / 200)` for backward-compatible embeds cap | Passed as `p_embeds_cap` to `bump_usage_if_within_cap` | **Hard** |
| `packages/shared/src/plans.ts` | `WORKSPACE_RPM_DEFAULT` / `WORKSPACE_RPM_SCALE` | 120 / 300 RPM | Enforced by `rateLimitWorkspace` (Durable Object) | **Hard** |

### 1.2 API key / request rate limits

| File | Function | Limit | Enforcement | Hard / Soft |
|------|----------|--------|-------------|-------------|
| `apps/api/src/auth.ts` | `rateLimit` | 60 RPM default; 15 RPM for keys &lt; 48h old | Durable Object `rl:{keyHash}`; 429 if exceeded | **Hard** |
| `apps/api/src/auth.ts` | `rateLimitWorkspace` | Plan `workspace_rpm` (120 or 300) | DO `rl-ws:{workspaceId}`; 429 if exceeded | **Hard** |
| `apps/api/src/limits.ts` | `getRateLimitMax` | Same as above (env + new-key grace) | Used by `rateLimit` | **Hard** |
| `apps/api/src/limits.ts` | `MAX_TEXT_CHARS`, `MAX_QUERY_CHARS`, `DEFAULT_TOPK`, `MAX_TOPK` | 50_000, 2_000, 8, 20 | Schema/validation in contracts | **Hard** (request rejected) |

### 1.3 Per-request / per-plan caps (enforced in handlers)

| File | Function | What | Enforcement | Hard / Soft |
|------|----------|------|-------------|-------------|
| `apps/api/src/workerApp.ts` | `reserveQuotaAndMaybeRespond` → `bumpUsageIfWithinCap` | writes, reads, embeds, embed_tokens, extraction_calls | Atomic RPC `bump_usage_if_within_cap`; 402 if any cap exceeded | **Hard** |
| `infra/sql/030_usage_plan_v2.sql` | `bump_usage_if_within_cap` | Same five dimensions; caps passed by Worker from plan | `FOR UPDATE` + check all caps; only then `INSERT/UPDATE` usage_daily | **Hard** |
| `apps/api/src/handlers/memories.ts` | `handleCreateMemory` | `max_text_chars`, `extraction_calls_per_day === 0` when `extract` | Before reserve: reject with `planLimitExceededResponse` | **Hard** |
| `apps/api/src/handlers/eval.ts` | `handleRunEval` | `EVAL_RUN_ITEMS_CAP = 100` | Items sliced to 100 before computing deltas and reserve | **Hard** |

### 1.4 Legacy unbounded bump (risk)

| File | Function | What | Enforcement | Hard / Soft |
|------|----------|------|-------------|-------------|
| `apps/api/src/workerApp.ts` | `bumpUsage` | writes, reads, embeds only (no embed_tokens, no extraction_calls) | Calls `bump_usage_rpc` — **no cap check**; pure increment | **Soft** (post-hoc, can exceed cap) |
| `infra/sql/018_usage_rls_repair.sql` | `bump_usage_rpc` | Same | Inserts/updates usage_daily without checking caps | **None** |

**Used only in:** `handlers/memories.ts` → `extractAndStore` (in `finally` block for **extraction child** writes/embeds). See §5.

---

## 2. COST-GENERATING OPERATIONS

### 2.1 OpenAI

| File | Function | Service | When cost happens vs quota |
|------|----------|---------|----------------------------|
| `apps/api/src/workerApp.ts` | `embedText` | OpenAI Embeddings (`text-embedding-3-small`) | **After** quota: called only after `reserveQuotaAndMaybeRespond` in memories, search, context, eval, import (import uses precomputed embeddings from artifact). |
| `apps/api/src/handlers/memories.ts` | `extractItems` | OpenAI Chat (`gpt-4o-mini`) | **After** 1 extraction call reserved for parent; **child** writes/embeds not reserved (see §5). |
| `apps/api/src/handlers/memories.ts` | `extractAndStore` → `embedText` (per child) | OpenAI Embeddings | **Before** any quota check for children; children accounted only via `bumpUsage` (unbounded) in `finally`. |

### 2.2 Vector DB / storage

| File | Function | Operation | When vs quota |
|------|----------|-----------|----------------|
| `apps/api/src/workerApp.ts` | `performSearch` → `callMatchVector` | Supabase/Postgres vector search | After reserve in search/context/eval. |
| `apps/api/src/workerApp.ts` | Memory/chunk inserts | Supabase inserts | After reserve (memories POST, import after preInsertGuard). |
| `apps/api/src/handlers/memories.ts` | `extractAndStore` → chunk/memory inserts | Supabase inserts for child memories | Before any cap check for children; only `bumpUsage` after. |

### 2.3 Background / admin (no user quota)

| File | Function | Cost | Quota check |
|------|----------|------|-------------|
| `apps/api/src/handlers/admin.ts` | `handleMemoryHygiene` | DB only: `find_near_duplicate_memories` uses existing embeddings (vector similarity). No new embed or LLM calls. | Admin-only; no workspace quota. |
| `apps/api/src/handlers/webhooks.ts` | Billing webhook | PayU verify (external HTTP); no embeddings/LLM. | N/A (billing). |
| `apps/api/src/handlers/export.ts` | `buildExportArtifact` | Read-only DB + zip; no embeddings. | No quota (export is read-only). |

---

## 3. RETRIES AND LOOPS

| File | Mechanism | Retry count / loop | Delay | Cost multiplication risk |
|------|-----------|--------------------|-------|---------------------------|
| `apps/api/src/workerApp.ts` | `fetchWithRetry` (embeddings) | 1 + `RETRY_MAX_ATTEMPTS` (2) = **3** attempts | `OPENAI_EMBED_RETRY_DELAYS_MS` [500, 1000] ms | Up to 3× embed cost per request on 5xx/429; quota already reserved for 1 embed (or N chunks), so we **under-count** cost on retries (bounded 3×). |
| `apps/api/src/handlers/memories.ts` | `extractItems` loop | 1 + 2 = **3** attempts | `OPENAI_EXTRACT_RETRY_DELAYS_MS` [500, 1500] ms | Up to 3× extraction LLM cost for one logical call; we reserve 1 extraction call — minor under-count, bounded. |
| `apps/api/src/supabaseRetry.ts` | `withSupabaseRetry` / `withSupabaseQueryRetry` | 1 + 2 = **3** attempts | `SUPABASE_RETRY_DELAYS_MS` [300, 700] ms | No direct external $ (Supabase usage is separate); no quota multiplication. |
| `apps/api/src/resilienceConstants.ts` | Constants | `RETRY_MAX_ATTEMPTS = 2` | Per-tool arrays | — |
| `apps/api/src/handlers/context.ts` | `for` over blocks/items | Bounded by request payload | — | No extra cost beyond reserved (context reserves for one query embed). |
| `apps/api/src/handlers/eval.ts` | `for (const item of cappedItems)` | Capped at **100** items | — | Quota reserved for full run before loop; no multiplication. |

**Verdict:** Retries are bounded (max 3 attempts). No unbounded loops that multiply cost without a prior reserve. The only unbounded cost multiplication is **extraction children** (see §5), which is not a retry but a missing pre-reserve.

---

## 4. QUOTA ENFORCEMENT ORDER

For each cost-generating path, order is:

- **Request** → **Auth** → **Rate limit (key)** → **Workspace rate limit** (where applicable) → **Quota resolve** → **Reserve (atomic)** → **External API / DB** → **No second bump** (except extraction children).

### 4.1 POST /v1/memories

1. Auth  
2. `requireWorkspaceId`  
3. `resolveQuotaForWorkspace` → if blocked → 402  
4. `rateLimit` (key)  
5. `rateLimitWorkspace`  
6. Parse body; check `max_text_chars`, `extraction_calls_per_day` for extract  
7. **Reserve:** `reserveQuotaAndMaybeRespond` (1 write, chunkCount embeds, embedTokensDelta, extractionCallsDelta: extract ? 1 : 0)  
8. **Cost:** `embedText(chunks)` → insert memory + chunks  
9. If extract: **Cost:** `extractAndStore` (OpenAI extraction + per-child embed + inserts); **then** `bumpUsage` (unbounded) for children only.

**Risk:** Step 9: child cost happens **before** any cap check for children; only post-hoc `bumpUsage` (no cap). **CRITICAL** (see §5).

### 4.2 POST /v1/search, POST /v1/context

1. Auth, requireWorkspaceId  
2. Quota resolve → 402 if blocked  
3. Key rate limit, workspace rate limit  
4. Parse; compute embedsDelta (0 or 1), embedTokensDelta  
5. **Reserve** with readsDelta: 1, embedsDelta, embedTokensDelta, extractionCallsDelta: 0  
6. **Cost:** `performSearch` → `embedText([query])` (if not keyword) → vector search  

**Risk:** None. Reserve before any external call.

### 4.3 POST /v1/import

1. Auth, rate limit  
2. Parse artifact; compute memoriesToWrite, chunksToWrite (no new embeddings; artifact has precomputed)  
3. **Reserve:** `preInsertGuard(deltas)` → `reserveQuotaAndMaybeRespond`  
4. **Cost:** DB inserts only  

**Risk:** None. No embed calls; reserve before insert.

### 4.4 POST /v1/eval/run

1. Auth, rate limit (and workspace rate limit after quota resolve)  
2. Load eval set; cap items at 100  
3. Quota resolve; workspace rate limit  
4. **Reserve** total deltas (reads, embeds, embed tokens) for full run  
5. **Cost:** loop over capped items → `performSearch` each (embed + vector per item)  

**Risk:** None. Single reserve before loop.

### 4.5 Other endpoints

- **Export, list, get, delete, usage, billing, api keys, workspaces, episodes, admin:** Either no external cost (DB read only) or admin-only. No quota reserve required for export/list (read-only).  
- **Memory hygiene:** Admin-only; DB RPC using existing embeddings; no new embed/LLM.

---

## 5. BYPASS PATHS

| Path | Description | Quota / cap | Risk |
|------|-------------|-------------|------|
| **Extraction children** (`extractAndStore`) | For each extracted item: LLM already called once (reserved); then `embedText(chunks)` + DB inserts per child. Child writes and embeds are **not** pre-reserved; they are only applied via `bumpUsage` in `finally`. `bumpUsage` calls `bump_usage_rpc`, which has **no cap** and does not touch `embed_tokens_used` or `extraction_calls`. | Children can exceed plan caps (writes, embeds). Child embed_tokens not recorded. | **CRITICAL** |
| Admin endpoints | Memory hygiene, webhook reprocess, billing health, cleanup sessions. | No workspace quota; admin token only. | Acceptable (admin-only). |
| Billing webhook | PayU verify; no embeddings. | N/A. | None. |
| Export | Read-only; no embeddings. | No quota (by design). | None. |
| List/Get/Delete memories | Read/delete only; no embed. | No quota. | None. |
| RATE_LIMIT_MODE=off | When off, key and workspace rate limits bypass. | Production env guard forbids `RATE_LIMIT_MODE=off` in non-dev. | Low if env is enforced. |

**Summary:** The only critical bypass is **extraction child writes/embeds** (and missing embed_tokens/extraction_calls accounting for children) — cost can exceed what was reserved and can exceed plan caps.

---

## 6. PLAN SAFETY

- **Every cost-generating operation consumes quota** for the **primary** path: memories (parent), search, context, import, eval — all reserve before cost.  
- **Exception:** Extraction **children**: they consume writes and embeds (and LLM for extraction is once per parent, reserved) but child writes/embeds are **not** reserved; they are only bumped with an uncapped RPC. So **not** every cost-generating operation is covered by a pre-reserve.  
- **Quota failures stop execution:** When `reserveQuotaAndMaybeRespond` returns a 402 response, handlers return immediately and do not call `embedText` or inserts.  
- **Operations without a plan limit:** Admin and webhook operations do not use workspace plan limits (by design). The only user-facing path that can run cost without a cap is extraction children.

---

## 7. COST SAFETY VERDICT

### A. Summary table

| Operation | Limit type | Hard cap? | Risk level |
|-----------|------------|-----------|------------|
| Memory create (parent) | writes, embeds, embed_tokens, extraction_calls | Yes (atomic reserve) | Low |
| Memory create (extraction children) | writes, embeds | No (bumpUsage only) | **Critical** |
| Search / context | reads, embeds, embed_tokens | Yes | Low |
| Import | writes, embeds, embed_tokens | Yes (preInsertGuard) | Low |
| Eval run | reads, embeds, embed_tokens (capped 100 items) | Yes | Low |
| Key rate limit | RPM | Yes | Low |
| Workspace rate limit | RPM | Yes | Low |
| Export / list / get / delete | — | N/A (no cost or read-only) | None |
| Memory hygiene | — | Admin; no embed cost | None |

### B. Bankruptcy risk: “Can this system spend more money than it earns?”

**Answer: Yes, in a narrow but real scenario.**

- **Runaway retries:** No. Retries are capped at 3 attempts; we reserve once per logical unit, so at worst we under-count cost (bounded 3× on that unit), not unbounded spend.  
- **Missing quota enforcement:** Yes for **extraction children**. A single memory with `extract: true` can create up to **MAX_EXTRACT_ITEMS (10)** child memories, each with embeddings. Only the parent’s 1 write, N embeds, and 1 extraction are reserved. The 10 child writes and their embeds are applied via `bumpUsage` with **no cap**. So a workspace near its daily cap can exceed writes/embeds (and we do not record child embed_tokens or extraction in the new columns).  
- **Background workers:** Memory hygiene does not call embeddings or LLM; no extra cost.  
- **Ingestion spikes:** Key and workspace rate limits (and atomic reserve on memories/import) limit spikes; the only leak is again extraction children.  
- **Embedding storms:** Rate limits + reserve-before-embed protect the main paths; extraction children remain the only path where embeds can run without a prior cap check.

**Conclusion:** The system can spend more than it charges **only** when users use **extract: true** and the resulting **child** writes/embeds push usage over plan caps (and child usage is not fully reflected in `embed_tokens_used`/`extraction_calls`). Severity is limited by: (1) at most 10 children per request (MAX_EXTRACT_ITEMS), (2) extraction_calls_per_day is 0 on Launch, and (3) one extraction call per parent is reserved. So the leak is bounded per request but can exceed plan caps and under-report usage.

---

## 8. MISSING PROTECTIONS

| Recommendation | Status | Notes |
|----------------|--------|--------|
| Reserve quota for extraction **children** before running extractAndStore | **Missing** | Either reserve an upper bound (e.g. 10 writes + 10× max chunk embeds) or reserve incrementally per child with `bumpUsageIfWithinCap` and abort when cap exceeded. |
| Use `bump_usage_if_within_cap` (or equivalent) for extraction child usage | **Missing** | Replace `bumpUsage` in `extractAndStore` with an atomic cap-checking path and include `embed_tokens` and `extraction_calls` for children if applicable. |
| Global cost kill switch | Partial | Circuit breaker for OpenAI exists; no global “stop all embed” switch. |
| Per-workspace daily spend cap | Not present | Only per-plan limits (writes/reads/embeds/tokens/extraction). |
| API call circuit breaker | Present | `circuitBreaker.ts` for OpenAI (and Supabase). |
| LLM budget guard | Partial | Extraction is 1 call reserved per parent; retries can do up to 3 calls (bounded). |
| Embedding batch caps | Present | Import and eval cap batch size; memories cap by chunk count in reserve. |
| Ingestion limits | Present | Rate limits + workspace RPM + atomic reserve. |

---

## 9. FINAL SCORE

**Cost Safety Score: 6.5 / 10**

- **Reasoning:**  
  - **Strengths (why not lower):** Atomic reserve-before-cost on all main paths (memories parent, search, context, import, eval); plan-based limits and workspace RPM; eval capped at 100 items; import uses precomputed embeddings; memory hygiene does not call embed/LLM.  
  - **Why not higher:** Extraction children are a **critical** gap: cost (writes + embeds + DB) occurs without a prior quota reserve; accounting uses unbounded `bumpUsage`, so plan caps can be exceeded and child embed_tokens/extraction_calls are not recorded. One abuse path (repeated memory creates with extract) can push a workspace over cap and generate uncapped cost.  
  - **0 = bankruptcy risk, 10 = impossible to overspend:** We are not at 0 because the main revenue-generating paths are protected and the leak is bounded per request (max 10 children). We are not at 10 because extraction children can exceed plan limits and under-report usage.

**Recommended next step:** Implement reserve (or cap-checking bump) for extraction children and record all child usage (including embed_tokens and extraction_calls if any) via the same atomic, cap-checking mechanism used for the rest of the API.
