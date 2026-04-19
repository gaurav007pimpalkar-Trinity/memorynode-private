# MEMORYNODE – COST DISCIPLINE & ABUSE CONTROL REVIEW

**Scope:** apps/*, packages/*, limits, usage tracking, rate limit DO, billing, plans, extraction, embedding, chunking, body/import/export limits, usage_daily, circuit breaker, retries, eval routes.  
**Rules:** No startup optimism; no system rewrite; no new infrastructure; Worker + Supabase only; solo-founder margin safety.

---

## 1. Hard Caps

### Answer

- **Are there true hard caps per workspace?**  
  **No.** Caps are enforced by a **pre-check** only. The flow is: `getUsage` → `exceedsCaps(caps, usage, delta)` → if over, return 402; else proceed and later call `bumpUsage`. The DB RPC `bump_usage_rpc` **unconditionally increments** usage; it does not enforce “increment only if new total ≤ cap.” So under concurrency, multiple requests can pass the check and then all bump, exceeding the cap.

- **Are writes, reads, embeds strictly enforced?**  
  **Partially.** Writes/reads/embeds are checked and returned 402 when the *projected* usage (usage + delta) exceeds plan caps. Enforcement is **not atomic** with the bump: check and bump are separate steps. So strict enforcement is only true in the single-request case.

- **Are caps atomic and race-safe?**  
  **No.** `checkCapsAndMaybeRespond` (workerApp.ts) reads `usage_daily` and compares to caps; later `bumpUsage` runs in a separate RPC. Two concurrent requests can both see usage = 99, both pass (e.g. cap 100), then both bump → 100 and 101. The `bump_usage` SQL (infra/sql/018_usage_rls_repair.sql) is atomic per row (INSERT … ON CONFLICT DO UPDATE), but there is no “bump only if result ≤ cap” condition.

- **Can caps be bypassed via import/export or multiple API keys?**  
  **Yes.**  
  - **Import:** `importArtifact` (workerApp.ts) does **not** call `checkCapsAndMaybeRespond` and does **not** call `bumpUsage`. A 10 MB import can insert many memories/chunks and burn embeddings elsewhere (e.g. re-ingest), but the import path itself does not account for writes/embeds. So **import bypasses usage and caps entirely**.  
  - **Export:** Does not consume writes/embeds; it is read-only. Rate limit and auth apply; no cap bypass for cost.  
  - **Multiple API keys:** Rate limit is **per key** (60 RPM default, 15 for new keys 48h). A workspace with N keys gets N × 60 RPM. Plan caps (writes/reads/embeds) are **per workspace**, so total usage is still bounded by the plan; but **throughput** can be multiplied by creating many keys (e.g. via dashboard or admin API).

**Code references:**

- Cap check: `workerApp.ts` `checkCapsAndMaybeRespond` (getUsage → exceedsCaps → 402), `limits.ts` `exceedsCaps`.
- Bump (no cap gate): `workerApp.ts` `bumpUsage` → `supabase.rpc("bump_usage_rpc", …)`; `infra/sql/018_usage_rls_repair.sql` (increment only).
- Import (no caps/usage): `handlers/import.ts` (no checkCaps, no bumpUsage); `workerApp.ts` `importArtifact` (inserts only).

### Conclusion

- **Strength:** Weak.  
- **Improvements (minimal change):**
  1. **Atomic cap at DB:** Add an RPC that bumps **only if** `usage_daily.writes + p_writes <= caps.writes` (and same for reads/embeds). Resolve caps in the same transaction (e.g. from `workspace_entitlements` or a small caps cache table). Call this RPC from the Worker instead of unconditional `bump_usage_rpc`; on “would exceed” return a dedicated error and respond 402. This keeps Worker + Supabase only and makes caps race-safe.
  2. **Import:** Before inserting in `importArtifact`, resolve quota for the workspace, get current usage, compute delta (e.g. `imported_memories` + total chunks as embeds), call the same cap check (or the new atomic bump RPC in “check-only” mode). If over cap, return 402 and do not insert. After successful insert, call bump for writes and embeds (or use the atomic RPC that enforces cap).
  3. **Eval:** Before the loop in `handleRunEval`, compute total delta (e.g. `items.length` reads + `items.length` embeds for hybrid/vector). Call `checkCapsAndMaybeRespond` with that aggregate delta; if over, return 402. Optionally cap `items.length` (e.g. max 50 or 100 per run) to bound cost per request.

---

## 2. Token-Based Accounting

### Answer

- **Does the system track real token usage?**  
  **No.** There is no token counter or OpenAI usage callback. Only **embed count** and **chunk count** are used.

- **Or does it approximate via embed count?**  
  **Yes.** Plans define `embed_tokens_per_day`; the API uses `embedsCapFromEmbedTokens(embed_tokens_per_day)` → `floor(embed_tokens_per_day / TOKENS_PER_EMBED_ASSUMED)` (plans.ts). `TOKENS_PER_EMBED_ASSUMED = 200`. So the enforced “cap” is **embeds count**, not tokens. `usage_daily.embeds` is incremented by: per write = chunk count; per search/context = 1 (or 0 for keyword-only).

- **Is embed_tokens_per_day truly enforced?**  
  **No.** Only the derived **embeds count** cap is enforced. The code and docs (limits.ts, plans.ts) state that embed_tokens/day is for “future hard gate” / “TODO (backlog).”

- **Can long-text users exceed intended token limits?**  
  **Yes.** Example: 50k-char memory (MAX_TEXT_CHARS = 50_000 in limits.ts) with chunk size 800, overlap 100 → many chunks (e.g. ~63). Each chunk is one embed; input tokens per chunk can be ~500+ (longer chunks). So 63 embeds counted vs ~63 × 500 = 31.5k input tokens. Plan “embed_tokens_per_day” is effectively under-enforced for long text; cost can be ~2–3× the implied cap for heavy long-text users.

**Code references:**

- `packages/shared/src/plans.ts`: `TOKENS_PER_EMBED_ASSUMED = 200`, `embedsCapFromEmbedTokens`, TODO on embed_tokens/day enforcement.
- `apps/api/src/limits.ts`: “Enforcement still uses embeds count; embed_tokens/day is documented and exposed for future hard gate.”
- `workerApp.ts`: `chunkText(text, 800, 100)`; memories handler counts `chunkCount` for cap check and bump.

### Conclusion

- **Strength:** Weak (count-based only; token-based cap not enforced).  
- **Lightweight token-estimation strategy (Worker-only, no heavy dependency):**
  - **Estimate input tokens per embed:** `estimatedTokens = Math.ceil(charLength / 4)` (rough 4 chars/token for English). Cap at a max per chunk (e.g. 512 or 8192) if you want to avoid huge single-chunk estimates.
  - **Store or use a daily token budget:** Add a `usage_daily.embed_tokens_used` column (or keep a separate table keyed by workspace_id + day). Increment by `estimatedTokens` on each embed (write: sum over chunks; search: one query embedding).
  - **Gate in the same place as today’s cap check:** Before ingest/search, compare `(usage.embed_tokens_used + estimatedTokens) <= plan.embed_tokens_per_day`. If over, return 402. Use the same atomic pattern as suggested for hard caps (single RPC that checks and bumps tokens).
  - **Performance:** One extra integer column and one extra comparison per request; optional second RPC if you keep “embeds” and “embed_tokens” in one row. Impact is minimal; no external service.

---

## 3. Per-Plan Fair Use

### Evaluate

- **Are plan limits aligned with real OpenAI cost?**  
  **Roughly for “average” usage; not for heavy/extraction-heavy usage.** Embed cost is ~$0.02/1M input tokens (text-embedding-3-small). Scale plan example: 60M embed_tokens/day → 300k embeds at 200 tokens → 60M tokens/day → ~$1.20/day → ~₹100/day. Scale price_inr 4999/30 ≈ ₹167/day. So embed-only at cap is below revenue. But extraction uses gpt-4o-mini (chat), and is **not** limited by a separate cap; heavy extract usage can dominate cost. Existing audit notes in `docs/COST_BILLING_AUDIT.md` and this review indicate extraction can create negative margin when usage is extraction-heavy.

- **Could a single heavy scale-plan user create negative margin?**  
  **Yes.** If they max out writes with `extract: true`, extraction cost (gpt-4o-mini) plus embed cost can exceed plan revenue. Scale plan is the main risk; scale_plus (custom) is unbounded by design.

- **Is extraction included in all plans?**  
  **Yes.** There is no plan or tier check before calling `extractAndStore`; any authenticated workspace can use `extract: true` on POST /v1/memories.

- **Should extraction be disabled in lower tiers, limited per day, or token capped separately?**  
  **Recommended:**  
  - **Launch / Build:** Either disable extraction (no `extract` or return 400/402), or allow with a **low daily cap** (e.g. 50 or 100 extractions per day) and enforce it in the same way as other caps.  
  - **Deploy / Scale:** Allow extraction but add a **daily extraction cap** (e.g. 500 / 2000) or a **separate token/cost cap** for chat so one workspace cannot burn unbounded extraction cost.  
  - **Token cap:** If you add token-based accounting, you could count extraction input/output tokens in a separate bucket and gate by `extraction_tokens_per_day` or similar.

### INR-based cost-to-revenue alignment

- **Launch (₹299/7 days):** Low writes/reads/embeds; extraction at low volume is manageable. Risk is small.  
- **Build (₹499/30 days):** 4M embed_tokens/day, 2k writes. If a large share of writes use extraction, chat cost can approach or exceed revenue.  
- **Deploy (₹1999/30 days):** Same pattern; extraction at scale can erase margin.  
- **Scale (₹4999/30 days):** Audit already states ~$96/mo OpenAI (embed + extraction) vs ~₹5000 revenue → possible loss at sustained cap with heavy extraction.  
- **Scale+ (custom):** No ceiling; margin must be managed by contract and monitoring.

**Recommendation:** Add **extraction caps per plan** (daily count or token cap) and optionally **disable extraction for Launch** (or cap at a small number). Publish the cap in plan limits and enforce in the same place as other caps.

---

## 4. Extraction Gating

### Answer

- **Is extraction currently available to all plans?**  
  **Yes.** No plan or entitlement check gates the `extract: true` path in memories handler.

- **Is it capped?**  
  **No.** There is no per-workspace or per-day extraction limit. Only the **single-memory** limit `MAX_EXTRACT_ITEMS = 10` (memories.ts) applies.

- **Is it behind rate limits only?**  
  **Yes.** Same 60 RPM (or 15 for new key) as other endpoints. So a single key can trigger 60 extract calls/min; each call can create up to 10 child memories and their embeddings.

- **Can extraction-heavy usage exceed revenue from that plan?**  
  **Yes.** As above: scale-plan user maxing writes with extract can push OpenAI cost (embed + gpt-4o-mini) above plan revenue.

**Code references:**

- `handlers/memories.ts`: `if (extract)` → `extractAndStore(...)`; no plan or extraction-cap check.
- `workerApp.ts` `checkCapsAndMaybeRespond`: called with delta for the **parent** memory only (1 write, chunkCount embeds); extraction’s extra writes/embeds are applied in `extractAndStore`’s `bumpUsage` in a `finally` block, after the fact, and are not pre-checked.

### Proposed: tier-based gating + daily cap

- **Tier-based gating:**  
  - In `resolveQuotaForWorkspace` (or equivalent), include an `extraction_allowed: boolean` and optionally `extraction_cap_per_day: number` from plan/entitlement.  
  - In the memories handler, when `extract === true`, if `!extraction_allowed` return 402 with a clear message (“Extraction not available on your plan”) or 400.  
  - Store `extraction_calls` (or `extraction_tokens`) per workspace per day in `usage_daily` or a small table; before calling `extractAndStore`, check today’s count + 1 ≤ extraction_cap_per_day; if over, return 402.

- **Daily extraction cap:**  
  - Add to plan limits (e.g. in plans.ts): `extraction_calls_per_day: number` (0 = disabled).  
  - In Worker: before `extractAndStore`, get usage (e.g. `usage_daily.extraction_calls`), compute delta = 1, run same style of check as writes/reads/embeds; if over cap, return 402. After successful extraction, bump `extraction_calls` (or use the same atomic RPC pattern as for other caps).

- **Feature flag:**  
  - Optional env or workspace-level flag to disable extraction globally or per workspace without code change (e.g. `EXTRACTION_ENABLED=false` or `workspace_entitlements.extraction_disabled`).

**Minimal implementation path:**  
1) Add `extraction_calls` to `usage_daily` and a migration. 2) Add `extraction_calls_per_day` (and optionally `extraction_allowed`) to plan limits in shared and to quota resolution. 3) In POST /v1/memories, when `extract === true`, call a small helper that checks extraction cap (and allowed) and returns 402 if over/not allowed. 4) In `extractAndStore`’s success path, bump `extraction_calls` for the day (or integrate into the same atomic bump RPC).

---

## 5. Aggressive Rate Limiting

### Evaluate

- **Current:** 60 RPM per key (15 for new keys, 48h). Implemented in `rateLimitDO.ts` (per-key bucket); `auth.ts` passes `keyHash` and optional `keyCreatedAt`; `getRateLimitMax(env, keyCreatedAt)` returns 15 or 60. No workspace-level throttle.

- **Is there workspace-level rate limiting?**  
  **No.** Only per-key. So 10 keys → 600 RPM per workspace.

- **Could a workspace create many keys to multiply throughput?**  
  **Yes.** Key creation is admin-only in the API (`requireAdmin` in apiKeys handler). Dashboard or admin can create many keys per workspace; each key gets 60 RPM. Throughput is multiplied; **plan caps** (writes/reads/embeds per day) still bound total usage, so cost is capped but **burst** and **load on OpenAI/DB** can spike.

- **Does rate limiting protect OpenAI sufficiently?**  
  **Partially.** 60 RPM per key limits request rate; under normal use this avoids a single key from flooding OpenAI. But many keys or many workspaces can still add up. Embed and extraction both go to OpenAI; extraction is not behind the circuit breaker (see existing audit), so repeated extraction can amplify load on 429/5xx.

**Code references:**

- `apps/api/src/rateLimitDO.ts`: per-key bucket, window 60s, limit from request body or env.  
- `apps/api/src/auth.ts`: `rateLimit(keyHash, env, auth)`; `getRateLimitMax(env, auth?.keyCreatedAt)`.  
- `apps/api/src/limits.ts`: `RATE_LIMIT_RPM_DEFAULT`, `RATE_LIMIT_RPM_NEW_KEY`, `NEW_KEY_GRACE_MS`.

### Incremental improvements (no architecture redesign)

1. **Workspace-level throttle (soft):**  
   Use a second Durable Object (or the same namespace) keyed by `workspace_id`, e.g. `rl-ws:${workspaceId}`. Allow a higher limit (e.g. 300 or 600 RPM) per workspace. Each request: check key limit as now; then check workspace limit. If either is exceeded, return 429. This caps total requests per workspace regardless of key count.

2. **Embed-specific throttle:**  
   Optional: separate bucket per key for “embed-heavy” operations (e.g. POST /v1/memories, and the embed path in search/context). E.g. 20 RPM for “embed” and 60 for general. Reduces burst embed load on OpenAI without changing overall request limit dramatically.

3. **Extraction-specific throttle:**  
   Per key (or per workspace): e.g. 10 or 20 extraction calls per minute. Implement by a dedicated DO bucket or a counter in the same DO, keyed by key or workspace. Prevents one key from burning extraction at 60/min.

All of the above can be implemented with existing Worker + DO; no new infra.

---

## 6. Abuse Detection

### What is already prevented

- **Large text:** `MAX_TEXT_CHARS = 50_000` in contracts/memories (Zod); request body size limited by `resolveBodyLimit` (e.g. MEMORIES_MAX_BODY_BYTES 1 MB). So a single request cannot send unbounded text.
- **Many chunks per memory:** Bounded by chunking (chunk size 800, overlap 100) and 50k chars → ~tens of chunks per memory; plan caps limit total writes/embeds per day.
- **Import size:** `MAX_IMPORT_BYTES` (default 10 MB); payload rejected if artifact exceeds it.
- **Eval:** Rate limit applies to POST /v1/eval/run; no cap check for the batch (see §1).
- **Key creation:** Admin-only in API; dashboard creates keys in a controlled flow. No per-workspace key limit in code.
- **Repeated failed billing:** No automated “disable after N failed payments” found in the scanned code; billing and webhook logic exist but no explicit abuse detection for failed billing.

### What abuse is possible

- **Import:** No usage/cap check; large imports can fill a workspace and bypass daily caps (cost is incurred when those memories are used elsewhere or re-embedded; import itself does not bump).
- **Eval run:** One request can run many items; each item = 1 read + 1 embed (or 0 for keyword). No pre-check for total delta → can burn through quota in one request.
- **Many keys:** Throughput multiplication (60 × N RPM) and more concurrent cap races.
- **Extraction:** No per-day cap; heavy extract usage can exceed revenue.
- **Long text:** 50k chars × many chunks → token cost above the implied embed_tokens cap (see §2).

### What would financially hurt the most

1. **Uncapped extraction** at scale plan (and above): chat cost can exceed revenue.  
2. **Import without cap check:** Enables “bulk load then use” to bypass daily write/embed caps.  
3. **Eval run without cap check:** Single request can consume a large share of daily reads/embeds.  
4. **Token overuse** (long text): margin erosion per heavy user.

### Minimal guardrails (solo-founder realistic; no heavy ML)

1. **Extraction cap:** Daily extraction limit per plan (or disable for Launch). Implement as in §4.  
2. **Import:** Require cap check (and optionally usage bump) for import; reject with 402 when the import would exceed plan caps (see §1).  
3. **Eval run:** Pre-check aggregate delta (reads + embeds) for the full run; return 402 if over. Optionally cap items per run (e.g. 50 or 100).  
4. **Alerting:** Use existing events: `cap_exceeded`, `rate_limited`. Add a simple alert (e.g. Cloudflare Workers Analytics or log-based) when a workspace hits cap or rate limit repeatedly in a short window; optionally when extraction_calls (once added) spike.  
5. **Optional per-workspace key limit:** E.g. max 5 or 10 active keys per workspace (count non-revoked keys on create); return 403 when exceeded. Reduces key-stuffing impact.

No ML or complex monitoring required; these are threshold and cap checks plus existing event logging.

---

## 7. Overall Rating

| Category                 | Rating    | Notes |
|--------------------------|-----------|--------|
| 1. Hard caps             | **Risky** | Pre-check only; not atomic; import and eval bypass. |
| 2. Token-based accounting| **Risky** | Embed count only; token cap not enforced; long text can exceed. |
| 3. Per-plan fair use     | **Risky** | Extraction uncapped; heavy use can create negative margin. |
| 4. Extraction gating     | **Risky** | Available to all plans; no daily cap. |
| 5. Rate limiting         | **Acceptable** | Per-key 60/15 RPM; no workspace throttle; multi-key multiplies throughput. |
| 6. Abuse detection       | **Acceptable** | Body/text/import size limits and rate limit; no cap on import/eval/extraction. |

### Is this system financially safe?

- **100 users, moderate usage:** **Probably.** Most usage will be below cap; occasional overages and extraction abuse are limited in scale.  
- **100 users, heavy usage:** **Risky.** Heavy extract users and long-text users can push cost above revenue; import/eval bypasses can create spikes.  
- **1,000 users, moderate usage:** **Risky.** Same issues at larger scale; margin depends on average usage staying below cap and extraction being light.  
- **1,000 users, heavy usage:** **Dangerous.** Uncapped extraction, import without cap check, and eval without cap check can combine to significant over-cost.  
- **5,000 users (any usage):** **Dangerous** without the suggested fixes. Concurrency and bypass vectors (import, eval, extraction) make cap and cost control unreliable.

**Recommendation:** Before scaling beyond ~100 paying users or allowing heavy extraction, implement: (1) atomic or at least import/eval-aware cap enforcement, (2) extraction gating and daily cap, (3) import and eval run cap checks. Optionally add token-based accounting and workspace-level rate throttle. Prioritize margin safety over feature richness.

---

## STRICT RULES (summary)

- No startup optimism; no system rewrite; no new infrastructure.  
- All suggestions are implementable in Cloudflare Worker + Supabase.  
- Solo-founder mindset: protect INR cash flow; show trade-offs.  
- Prioritize margin safety over feature richness.
