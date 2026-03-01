# MEMORYNODE – POST-STAGE-3 TECHNICAL & COST AUDIT (SOLO FOUNDER EDITION)

**Date:** 2026-03-01  
**Scope:** Full repo scan after Stage 3 (Resilience) upgrade.  
**Assumptions:** Solo founder, no DevOps team, limited runway, Cloudflare Workers + Supabase + OpenAI + PayU, no 24/7 monitoring.

---

---------------------------------------------------
## 1. Executive Summary
---------------------------------------------------

**Current maturity level:** **Stability / early Resilience.** Correctness improved (tenant guards, structured errors). Stability improved (honest health/ready, retries, timeouts, circuit breakers). Not yet "beyond resilience" (no multi-region, no embed cache, no queue).

**Is this safe for paid users?** **Cautiously yes for small scale.** Health and ready are now honest; extraction and PayU fail visibly; circuit breakers limit retry storms. Remaining risks: embed_tokens/day not enforced (only embed count); single Supabase/OpenAI/DO; no 24/7 alerting; production route and /ready were historically misconfigured (audit 2026-02-27)—verify after every deploy.

**Biggest remaining technical risk:** **Single points of failure.** One Supabase project, one OpenAI key, one Rate Limit Durable Object namespace. DB or OpenAI outage or rate limit (429) affects all tenants. Extraction is not behind the circuit breaker, so under extraction load failures can still hammer OpenAI.

**Biggest financial risk:** **OpenAI cost vs plan revenue.** Embedding and extraction are not capped by token count; only by embed *count* (derived from embed_tokens_per_day / 200). A user at plan limit can push 2x–3x the intended token volume with long text (many chunks per memory), and extraction has no usage cap—repeated ingest with `extract: true` multiplies chat cost.

**What would break under moderate growth?** At ~500–1k active users: Supabase connection/query load (no pooling; one client per request); OpenAI 429s and cost; hot Rate Limit DOs. At 5k–10k: Supabase tier upgrade mandatory; OpenAI cost can exceed revenue on heavy plans; no queue or backpressure so traffic bursts hit DB and OpenAI directly.

---

---------------------------------------------------
## 2. Architecture Re-Audit (After Stage 3)
---------------------------------------------------

### Health and readiness: honest

- **GET /healthz:** Returns `status`, `version`, `build_version`, `stage`, `embedding_model`, `git_sha`. In non-dev, validates critical env (SUPABASE_SERVICE_ROLE_KEY, API_KEY_SALT, etc.); stub/rate-limit config validated; returns **500** with `error: { code: "CONFIG_ERROR", message }` when invalid. Single code path; no dead early return.
- **GET /ready:** Runs real Supabase probe (`app_settings` select limit 1) inside **circuit breaker** + **Supabase retry**. Returns **503** if DB unreachable or circuit open; **200** only when probe succeeds (`status: "ok", db: "connected"`). Completion logged for every outcome.

**Verdict:** Health and ready are now honest signals for load balancers and deploy verification.

### Circuit breaker logic: correct but incomplete

- **Implementation:** `circuitBreaker.ts`: in-memory, per dependency (`openai`, `supabase`). **5 failures in 60s** → open **60s**; then one probe; success → close, failure → reopen 60s. No persistence across deploys.
- **Used for:** (1) Ready probe (Supabase), (2) OpenAI **embed** only. **Not used for:** OpenAI extraction (`extractItems` in memories.ts), or for general Supabase handler calls (only ready and auth path use retry; many direct Supabase calls have no retry).
- **Correctness:** Logic is correct. **Gap:** Extraction path does not go through the circuit breaker. When OpenAI is flaky, embed path opens the circuit and returns 503; extraction continues to retry (up to 3 attempts per request) and can amplify load on OpenAI.

### Retry storm risks

- **Controlled:** Embed: 2 retries, [500, 1000] ms, 30s timeout per attempt; circuit breaker opens after 5 failures. Ready: Supabase retry + circuit breaker. PayU verify: 2 retries, [500, 1500] ms, 10s timeout.
- **Risk:** Extraction: 2 retries, [500, 1500] ms, 15s timeout, **no circuit breaker**. Many concurrent create-memory requests with `extract: true` during an OpenAI outage → each does up to 3 attempts → retry storm on chat/completions. Mitigation: same "openai" circuit could be used for extraction (code change); currently only embed uses it.
- **Supabase:** Only auth, ready, and explicitly wrapped paths use `withSupabaseQueryRetry`. Other handler paths (memories insert, chunks insert, search RPCs, usage bump) have **no retry**. Transient DB errors on those paths fail the request immediately.

### Remaining single points of failure

| Component | Risk |
|-----------|------|
| Supabase | Single project; all tenants; no read replica; connection per request (no pool). |
| OpenAI | Single API key; rate limits (429) and cost apply globally. |
| Rate Limit DO | Single namespace; keys hash to DO instances; hot keys can concentrate load. |
| PayU | Single verify endpoint; retry added in Stage 3; webhook idempotency in place. |

### Operational blind spots

- **No circuit breaker or retry** on most Supabase writes/reads (memories, chunks, usage_daily, search RPCs). A brief Supabase blip causes 500s with no retry.
- **Extraction not behind circuit breaker** (see above).
- **Embed_tokens_per_day** is not enforced; only **embed count** (floor(embed_tokens_per_day / 200)) is enforced. Plans promise tokens/day; code has TODO; abuse via long text → many chunks burns more tokens than "cap" implies.
- **Eval** (`/v1/eval/*`) uses auth and rate limit but runs search internally; caps are applied via search path. No extra cap or cost guard on eval runs.
- **Export/import:** Capped by byte size (10 MB); no per-memory or per-chunk count limit. Export is a full workspace read; import can create many memories in one request (within 10 MB). Both count toward plan writes/reads/embeds; heavy export/import can burn quota and DB/OpenAI load.
- **Memory hygiene workflow** (GitHub Action, weekly): Exits 0 even on non-2xx unless fixed; if not, failures are silent in CI.
- **Production route:** CLOUDFLARE_INFRASTRUCTURE_AUDIT (2026-02-27) reported `memorynode-api` with no zone route and api.memorynode.ai/ready → 404. wrangler.toml has production route; live state must be re-verified after each deploy.

### What improved (Stage 3)

- Healthz returns version, stage, embedding_model; validates env in non-dev; 500 on missing critical config.
- Ready performs real DB probe with circuit breaker + retry; 503 on failure.
- Embed: request timeout (30s), retry with backoff, circuit breaker; 503 when circuit open.
- Extraction: retry + timeout; 503 + EXTRACTION_ERROR on failure (no silent []).
- PayU verify: retry + timeout from constants.
- requireWorkspaceId on create-memory, search, list history, replay → 400 if workspace_id missing.
- Centralized resilience constants; critical flow and tenant isolation tests.

### What is still fragile

- Most Supabase calls have no retry.
- Extraction not behind circuit breaker.
- embed_tokens_per_day not enforced; only embed count.
- Single DB, single OpenAI, single DO namespace.
- No backpressure or queue; bursts hit dependencies directly.
- No 24/7 monitoring or alerting; solo founder must manually check.

---

---------------------------------------------------
## 3. Operational Burden Analysis (Solo Founder Reality)
---------------------------------------------------

### Things you must manually monitor

1. **Supabase:** Dashboard (connection count, CPU, storage, error rate). No in-app alerting.
2. **OpenAI:** Usage and cost in OpenAI dashboard; 429 rate limit events (only visible when requests fail or logs show embed_request failure).
3. **Cloudflare:** Worker request count, errors, DO usage (if on paid plan). No built-in alert to you.
4. **PayU:** Webhook delivery, failed/deferred events (BILLING_RUNBOOK: reprocess endpoint). Reconcile on ambiguity in prod.
5. **Health/ready:** Only if you poll /healthz and /ready or use an external uptime checker.
6. **Usage/caps:** Plan usage (writes, reads, embeds) is in DB (usage_daily); no automated "approaching cap" or "cap exceeded" alert to you.
7. **Deploy verification:** Confirm api.memorynode.ai route and /ready 200 after each production deploy.

### Where silent failures can still occur

- **Memory hygiene workflow:** If workflow does not fail on non-2xx, failed API calls are silent.
- **Billing webhook:** Deferred/failed events require manual reprocess (POST /admin/webhooks/reprocess); no automatic retry or alert.
- **Supabase:** Transient errors on non-retried paths (most writes/reads) return 500 to user; no automatic retry; no alert to founder unless user reports or logs are checked.
- **Circuit breaker:** Opens and logs `circuit_breaker_open`; no push alert. You discover when users see 503 or you check logs.

### Alerts you would need (realistic minimum)

1. **Uptime/health:** External cron (e.g. every 5 min) GET /ready; alert if non-200 (e.g. PagerDuty, email, Slack).
2. **Supabase:** Supabase dashboard alerts (if available) or external DB ping; alert on high error rate or downtime.
3. **OpenAI:** Budget alert in OpenAI dashboard (e.g. monthly cap); and/or log aggregation for 429/5xx from embed/extraction.
4. **Billing:** Weekly check of deferred/failed webhook events (or script that calls /admin/webhooks/reprocess status and alerts if count > 0).
5. **Errors:** Log aggregation (e.g. Cloudflare Workers analytics or external) for 5xx rate spike.

### What could wake you at 2 AM

- **Supabase outage or high latency** → Ready 503, user-facing 500s on all API paths.
- **OpenAI outage or 429** → Embed 503 (circuit open after 5 failures); extraction 503 after retries; users cannot write or search with vector.
- **PayU webhook flood or verify down** → Payments not verified; entitlements not granted; users complain.
- **Rate Limit DO unavailable** → 503 RATE_LIMIT_UNAVAILABLE for all requests until DO recovers.
- **Misconfigured deploy** → e.g. production route missing or /ready 404 → LB marks backend unhealthy; traffic dropped or misrouted.

**Honest summary:** Without a monitoring/alerting stack, you rely on user reports and ad-hoc log checks. One external cron hitting /ready and alerting on non-200 is the minimum; the rest is manual or best-effort.

---

---------------------------------------------------
## 4. COST STRUCTURE ANALYSIS
---------------------------------------------------

### Assumptions (stated clearly)

- **Users:** "Active" = at least 1 write or 1 search per day.
- **Memories per user per day:** 10 (light), 30 (medium), 100 (heavy). **Searches per user per day:** 20 (light), 60 (medium), 200 (heavy).
- **Chunks per memory:** chunkText(text, 800, 100) → ~1 chunk per 700 chars; max text 50k chars → ~63 chunks max. **Assumption:** average 5 chunks per memory → 5 embeds per write.
- **Vector search:** 1 embed per vector search (keyword search = 0 embeds). Assume 70% vector, 30% keyword → 0.7 embeds per search.
- **Extraction:** 20% of writes use `extract: true`; 1 chat completion per such write. Input ~1k tokens, output ~0.3k tokens (gpt-4o-mini).
- **Pricing (approximate):**
  - **OpenAI:** text-embedding-3-small $0.02/1M input tokens (~200 tokens/embed → $0.004 per 1k embeds). gpt-4o-mini $0.15/1M in, $0.60/1M out → ~$0.0006–0.001 per extraction.
  - **Supabase:** Free 500MB DB, 2GB egress; Pro $25/mo, 8GB, included egress limits then overage.
  - **Cloudflare Workers:** Free 100k req/day; Paid $5/mo, 10M req included, $0.30 per million after. DO: 1M req included (Paid), $0.15 per million after.
  - **PayU:** Assume 2% per transaction (unclear from code; typical for Indian gateways).

---

### 4.1 Infrastructure Components

**Cloudflare Workers**

- One request ≈ one invocation (health, API, static if any). No separate static asset serving in worker from scanned code.
- **0–50 users:** ~5k–20k req/day (health, ready, API) → free tier (100k/day).
- **100 users:** ~50k–150k req/day → free or just over → **$0–5/mo**.
- **1,000 users:** ~500k–1.5M req/day → **~$5 base + overage** → **~$10–25/mo** (assume 15–45M req/month).
- **10,000 users:** ~5M–15M req/day → **~$50–150/mo** (request overage + CPU).

**Durable Objects (Rate Limit)**

- One rate-limit check per authenticated API request (not health/ready). So DO requests ≈ API request volume.
- **0–50 users:** within free 100k/day.
- **100 / 1k / 10k:** Same order as Worker requests. Paid: 1M DO req included; then $0.15/M. At 1k users ~30M req/mo → **~$4–5 DO overage**. At 10k → **~$45 DO**.

**Supabase (DB + storage + egress)**

- **Free tier:** 500MB DB, 2GB egress. **Pro:** $25/mo, 8GB, egress overage.
- **0–50 users:** Free tier sufficient (small tables, few GB egress).
- **100 users:** ~300k–1M rows (memories + chunks), hundreds of MB → **Free or low Pro** → **$0–25/mo**.
- **1,000 users:** DB growth ~tens of GB (chunks with 1536-dim vectors); egress grows. **Pro required** → **$25–80/mo** (with overage).
- **10,000 users:** **Pro + significant overage or higher tier** → **$100–300+/mo** (storage + egress; exact tier unclear from code).

**OpenAI (embeddings + extraction)**

- **Embedding:** $0.02/1M input tokens; ~200 tokens/embed → **$0.004 per 1k embeds**.
- **Extraction:** gpt-4o-mini ~$0.001 per call (round up).
- **0–50 users:** 50 × (10×5 + 20×0.7) ≈ 3.2k embeds/day, + extraction 50×10×0.2×1 = 100 extractions/day → **~$0.02/day embed + $0.10/day extract** → **~$3–4/mo**.
- **100 users:** **~$7–12/mo** (embed) + **~$2–4/mo** (extract) → **~$10–16/mo**.
- **1,000 users:** **~$70–120/mo** (embed) + **~$20–40/mo** (extract) → **~$90–160/mo**.
- **10,000 users:** **~$700–1200/mo** (embed) + **~$200–400/mo** (extract) → **~$900–1600/mo**.

**PayU (transaction fees)**

- Plan checkout only; not per-API. Assume 2% of GMV. **0–50 users:** few txns → **~$0–5/mo**. **100 / 1k / 10k:** depends on mix of plans and renewals; **~$5–50/mo** at 100, **~$50–200/mo** at 1k, **~$200–1000/mo** at 10k (order of magnitude).

**CI/CD and monitoring**

- GitHub Actions: free tier usually sufficient (build, test, smoke, migration drift). Optional external uptime/monitoring: **$0–30/mo**.
- **Total CI/monitoring:** **$0–30/mo**.

---

### Summary table (monthly, approximate)

| Component        | 0–50 users | 100 users   | 1,000 users   | 10,000 users   |
|-----------------|------------|------------|---------------|----------------|
| Cloudflare      | $0         | $0–5       | $10–25        | $50–150        |
| DO              | $0         | $0–2       | $4–5          | $45            |
| Supabase        | $0         | $0–25      | $25–80        | $100–300+      |
| OpenAI          | $3–4       | $10–16     | $90–160       | $900–1600      |
| PayU            | $0–5       | $5–50      | $50–200       | $200–1000      |
| CI/monitoring   | $0         | $0–30      | $0–30         | $0–30          |
| **Total**       | **~$5–15** | **~$20–130** | **~$180–500** | **~$1300–3100+** |

*Assumptions: medium usage (30 writes, 60 searches per user per day), 5 chunks/memory, 20% extraction. Heavy usage or abuse can push OpenAI 2–3x higher.*

---

---------------------------------------------------
## 5. OPENAI COST RISK ANALYSIS
---------------------------------------------------

### Cost per 1,000 memories ingested

- **Embeds:** 1000 memories × 5 chunks (avg) = 5,000 embeds → 5k × 200 tokens ≈ 1M input tokens → **$0.02**.
- **Extraction:** If 20% use extract → 200 extractions × ~$0.001 ≈ **$0.20**.
- **Total per 1k memories:** **~$0.22** (embed-heavy) to **~$0.25** (with extraction). Long text (e.g. 20 chunks/memory) → 20k embeds → **~$0.08** embed only; extraction unchanged.

### Cost per 1,000 searches

- **Vector:** 1000 × 0.7 = 700 embeds → 700 × 200 tokens = 140k tokens → **~$0.003**.
- **Keyword-only:** $0.
- **Per 1k searches:** **~$0.003** (mixed 70% vector).

### Worst-case monthly OpenAI exposure if rate limits abused

- **Rate limit:** 60 RPM per key; new keys 15 RPM for 48h. So max 60 × 60 × 24 × 30 ≈ **2.59M requests/month per key** if every request is at limit. Not all are embed; but if all were embed: 2.59M embeds × 200 tokens ≈ 518B tokens → unrealistic. Realistic abuse: many keys per workspace (each 60 RPM) → e.g. 10 keys = 600 RPM → 25.9M req/mo. If 50% are write (embed 5 each) + 50% search (1 embed): 12.95M × 5 + 12.95M × 1 ≈ 77.7M embeds/month → 15.5B tokens → **~$310/month embed** for one workspace at max rate limit. Plan caps (writes/reads/embeds per day) cap **usage_daily**; so after cap exceeded, requests return 402. So **worst case is bounded by plan cap**, not by rate limit alone. Worst case at plan cap (e.g. scale_plus 100k writes, 200k reads): 100k × 5 + 200k × 0.7 = 640k embeds/day → 19.2M embeds/month → **~$77/month embed** for one workspace. Extraction: 20% of 100k = 20k/day → 600k/month → **~$600/month** extraction. **Total worst-case one scale_plus workspace:** **~$677/month** (embed + extraction). Multiple such workspaces would multiply.

### Can one user bankrupt the system?

- **Within plan:** A single workspace on scale_plus (or high plan) can do up to ~100k writes/day, 200k reads/day. Embeds cap = 1M/day (200M tokens/day / 200). So **~$4/day embed** + extraction on 20k writes → **~$20/day extraction** → **~$24/day** → **~$720/month** for one abusive workspace. If pricing is INR 4999 (scale) or custom (scale_plus), revenue is ~$60–100 or custom; **cost can exceed revenue** for that workspace.
- **Mitigations:** Plan caps (writes/reads/embeds) are enforced; so abuse is capped per plan. **But:** embed_tokens_per_day is **not** enforced; only embed count. So a user can send 50k-char memories (many chunks) and burn more tokens than the "cap" implies (e.g. 2x–3x). So **marginally: one heavy user can push cost higher than the cap suggests**; full "bankruptcy" would require many such workspaces or a bug (e.g. cap not enforced).

### Are embed_tokens_per_day limits truly enforced?

- **No.** Code enforces **embeds count** only: `embedsCapFromEmbedTokens(embed_tokens_per_day)` → `floor(embed_tokens_per_day / 200)`. Usage_daily.embeds is incremented by **chunk count** (writes) and **1 or 0** (search). So a 50k-char memory → 63 chunks → 63 embeds counted; actual tokens could be ~63 × 500 = 31.5k tokens (if 500 tokens/chunk) vs 63 × 200 = 12.6k assumed. So **token-based overuse is possible**; enforcement is by count, not tokens.

---

---------------------------------------------------
## 6. SUPABASE SCALE & COST ANALYSIS
---------------------------------------------------

### Query volume (rough)

- Per request: auth (salt + api_keys), then handler: memories (insert + chunks insert + bump_usage + optional extraction children) or search (match_chunks_* RPCs + bump_usage) or export/import (large reads/writes).
- **100 users:** ~3k–10k API req/day → ~10k–50k DB ops/day (auth + handler). **1,000 users:** ~50k–150k req/day → **~200k–500k DB ops/day**. **10,000 users:** ~500k–1.5M req/day → **~2M–5M+ DB ops/day**.

### Storage growth

- **memories:** id, workspace_id, user_id, namespace, text (up to 50k chars), metadata, created_at, memory_type, source_memory_id. ~1–50 KB per row.
- **memory_chunks:** id, workspace_id, memory_id, user_id, namespace, chunk_index, chunk_text, **embedding vector(1536)**, tsv, created_at. 1536 × 4 bytes ≈ 6 KB per embedding; chunk_text ~1 KB. **~7–10 KB per chunk**. At 5 chunks/memory, **~35–50 KB per memory**.
- **100 users,** 30 memories/user/day × 30 days → 90k memories → **~3–5 GB** (chunks dominate). **1,000 users:** **~30–50 GB**. **10,000 users:** **~300–500 GB** (Pro tier insufficient; need higher tier or separate scaling).

### Index costs (vector search)

- ivfflat on `embedding` (lists = 100 in 001_init.sql). Build and maintenance scale with rows; query cost with list count. No explicit cost in code; part of DB CPU/storage.

### Risk of connection saturation

- **One Supabase client per request** (createSupabaseClient per request); no connection pool in Worker. Supabase server-side pool limits apply. Under high concurrency, connection churn can approach pool limit; risk of saturation at **high request concurrency** (order of hundreds to low thousands concurrent). Unclear exact Supabase Free/Pro connection limits from code; docs typically 60–200+ per project.

### When upgrade to higher Supabase tier becomes mandatory

- **Free:** 500MB DB, 2GB egress. With **~100 active users** and 3–5 GB data growth, **Pro ($25) needed** within months.
- **Pro:** 8GB. **~1k users** with 30–50 GB → **Pro overage or Team/Enterprise** for storage. Egress and connection limits also drive upgrade. **Roughly: 1k users** is where Pro becomes tight; **5k–10k** likely requires Team or custom.

---

---------------------------------------------------
## 7. CLOUDFLARE COST & SCALE ANALYSIS
---------------------------------------------------

### Worker invocation cost

- **Free:** 100k req/day. **Paid:** $5/mo, 10M req included, **$0.30 per million** after.
- **0–50 users:** Free. **100 users:** Free or low overage. **1k users:** ~15–45M req/month → **~$2–11 overage**. **10k users:** ~150–450M req → **~$42–132 overage** (plus base $5).

### Durable Object usage implications

- Rate Limit DO: one request per authenticated request. Same volume as Worker API requests. **$0.15 per million** (after 1M included). At 1k users ~30M req/mo → **~$4–5 DO**. At 10k → **~$45**. DO duration (GB-s) can matter if DOs stay hot; code uses simple in-memory counters; hibernation may apply (unclear from code).

### Risk of unexpected billing spikes

- **OpenAI:** Highest risk (embed + extraction); plan caps limit per-workspace usage but token overuse (long text) can push cost up. **Mitigation:** Enforce embed_tokens or reduce max text/chunk.
- **Cloudflare:** Worker + DO scale with request volume; predictable per million. Spike only if traffic spikes (e.g. viral or attack). Rate limit (60 RPM) and plan caps limit per-key and per-workspace throughput.
- **Supabase:** Overage if storage or egress exceeds plan; growth is gradual unless import/export abuse.

### Cold start / CPU limit exposure

- Workers: cold start low (ms). CPU time billed after 30M ms included (Paid); heavy CPU per request (e.g. large JSON parse, chunkText on 50k chars) can add up. **Unclear from code:** exact CPU per request; no evidence of CPU limit issues. DO cold start: first request per key hash in window may hit new DO instance; latency spike possible.

---

---------------------------------------------------
## 8. Break-Even & Sustainability Model
---------------------------------------------------

### Plan tiers (from code, INR)

| Plan       | price_inr | Period   | USD (approx @ 83) |
|-----------|-----------|----------|---------------------|
| launch    | 299       | 7 days   | ~$3.6               |
| build     | 499       | 30 days  | ~$6                  |
| deploy    | 1999      | 30 days  | ~$24                 |
| scale     | 4999      | 30 days  | ~$60                 |
| scale_plus| 0 (custom)| —        | custom               |

### Gross margin (revenue − infra cost) – rough

Assume **100 users:** mix 40% launch, 30% build, 20% deploy, 10% scale. Revenue: 40×3.6 + 30×6 + 20×24 + 10×60 ≈ $144 + $180 + $480 + $600 = **$1404/mo**. Infra (from §4): **~$20–130** (conservative $80). **Gross margin ~95%** at 100 users.

**1,000 users:** Same mix. Revenue **~$14,040/mo**. Infra **~$180–500** (use $350). **Margin ~97%**.

**5,000 users:** Revenue **~$70,200**. Infra **~$700–1500** (OpenAI dominates). **Margin ~98%**.

### When infra cost becomes dangerous

- **Per-workspace:** At scale_plus or heavy usage, one workspace can cost **$100–700/mo** (OpenAI) vs **$60–100** revenue (scale) or custom (scale_plus). **Heavy users can be loss-making.**
- **Platform-level:** At 10k users, infra **~$1300–3100**; revenue (same mix) **~$140k**. Margin still high **unless** many users are on high plans with heavy usage (then OpenAI share grows). **Abuse or many scale_plus custom deals** can compress margin.

### Whether pricing supports OpenAI-heavy usage

- **Light/medium usage:** Yes; embedding is cheap ($0.004/1k embeds); extraction adds ~$0.001/call; plan revenue covers many embeds per rupee.
- **Heavy at plan cap:** Scale 60M embed_tokens/day → 300k embeds → **~$1.20/day embed** → **~$36/mo**; extraction on 10k writes/day × 20% = 2k/day → **~$60/mo**. **~$96/mo** OpenAI vs **~$60** revenue → **loss per workspace** at cap. So **pricing does not support sustained heavy usage at scale plan cap**; margin relies on average usage below cap.

### Plan limits vs real cost

- **Writes/reads:** Enforced; aligned with product.
- **Embed count:** Enforced; **token equivalent** (embed_tokens_per_day) **not** enforced; real token cost can exceed implied cap for long text. **Misalignment:** Plans sell "embed_tokens_per_day"; enforcement is embed count only.

---

---------------------------------------------------
## 9. Catastrophic Cost Scenarios
---------------------------------------------------

| Scenario | Risk level | Mitigated? | Additional guardrail? |
|----------|------------|------------|------------------------|
| **Abuse: many keys per workspace** | Medium | Partially: 60 RPM per key, 15 for new keys; plan caps (writes/reads/embeds) apply to workspace. | Workspace-level rate or cap optional. |
| **Abuse: max text per memory (50k chars → 63 chunks)** | Medium | Plan caps limit writes and embeds per day; 63 embeds per write count. | Enforce embed_tokens_per_day or lower MAX_TEXT_CHARS / chunk size. |
| **Retry amplification (extraction)** | Medium | Extraction has 2 retries; no circuit breaker. | Put extraction behind same "openai" circuit breaker. |
| **Retry amplification (Supabase)** | Low | Auth and ready use retry; circuit breaker on ready. | Add retry to critical handler paths (writes, search RPC). |
| **Token explosion from large inputs** | Medium | Body limit 1 MB (memories); 50k chars; chunking caps chunks. Embed count enforced; tokens not. | Cap input tokens or enforce token-based usage. |
| **Export misuse (full workspace read)** | Low | Rate limit + auth; 10 MB export cap; plan read cap. | Per-day or per-workspace export count limit optional. |
| **Import misuse (bulk create)** | Medium | 10 MB cap; plan write/embed caps; import counts toward caps. | Enforce; consider per-import memory count limit. |
| **Eval runs (many searches)** | Low | Auth + rate limit; search path applies caps. | Optional: eval-specific cap or cost guard. |
| **OpenAI 429 → circuit open → all embed 503** | Operational | Circuit breaker fails fast; 60s cooldown. | Alert on circuit open; consider per-tenant or backup provider later. |
| **One workspace at scale_plus cap** | High (margin) | Plan caps enforced. | Price scale_plus to cover cost or enforce token-based cap. |

---

---------------------------------------------------
## 10. What A Solo Founder Must Add Next
---------------------------------------------------

### 1. Immediate

- **Verify production route and /ready:** Confirm api.memorynode.ai routes to memorynode-api and GET /ready returns 200 after every production deploy. Fix if not (CLOUDFLARE_INFRASTRUCTURE_AUDIT found 404).
- **One uptime/health check:** External cron (e.g. every 5 min) GET /ready; alert (email/Slack) if non-200. Prevents "discover outage when users complain."
- **Memory hygiene workflow:** Ensure workflow fails (exit non-zero) when API returns non-2xx so failures show in CI/alerts.
- **Put extraction behind circuit breaker:** Call `extractItems` (or the fetch inside it) via `withCircuitBreaker("openai", ...)` so extraction respects same circuit as embed and does not retry when circuit is open.

### 2. Soon

- **Embed token enforcement or doc alignment:** Either (a) implement approximate token tracking (e.g. chunk length → token estimate) and gate on embed_tokens_per_day, or (b) remove or reword "embed_tokens_per_day" in plans/docs so it matches "embed count only." Prevents margin surprise from long-text users.
- **Billing webhook alert:** Weekly (or daily) script or cron that checks deferred/failed webhook count (e.g. via admin endpoint or DB) and alerts if > 0.
- **OpenAI budget alert:** Set monthly budget and alert in OpenAI dashboard (or equivalent) so cost spike is visible.
- **Retry for critical Supabase paths:** Add `withSupabaseQueryRetry` (or equivalent) to memory insert, chunks insert, and search RPC calls so transient DB errors are retried once or twice.

### 3. Later

- **Circuit breaker metrics:** Expose circuit state (open/closed) per dependency for a dashboard or status page (when you have one).
- **Per-workspace or per-tenant cost visibility:** Track approximate OpenAI cost per workspace (e.g. from embed/extraction logs) to identify loss-making accounts.
- **Scale_plus pricing and token cap:** If scale_plus is sold as custom, ensure price covers worst-case token usage or enforce token-based cap.
- **Queue or backpressure:** For scale, consider async embed or queue for heavy writes to smooth load and avoid bursts to OpenAI/DB.

---

**Document generated from repository scan (apps/*, packages/*, workers, sdk, docs, CI, billing, limits, resilience constants, circuit breaker, handlers). Pricing and tier details are approximate; "Unclear from code" used where applicable. Financially conservative; worst-case but realistic usage assumed.**
