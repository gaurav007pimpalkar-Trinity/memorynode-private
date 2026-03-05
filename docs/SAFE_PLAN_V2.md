# Safe Plan v2 — Financial Protection Layer

This document describes the Plan v2 protection layer: migration steps, behavior, and how it protects INR margins under worst-case usage.

## Overview

Plan v2 adds:

- **Plan-based limits** (writes, reads, embed tokens, extraction calls, `max_text_chars`, workspace RPM)
- **Atomic cap enforcement** via a single RPC `bump_usage_if_within_cap`
- **Token-based accounting** (`embed_tokens_used`, estimated as `ceil(text.length/4)`)
- **Extraction gating** (per-plan `extraction_calls_per_day`; Launch has 0)
- **Workspace-level rate limit** (120 RPM default, 300 RPM for Scale/Scale+)
- **Consistent 402 error shape** (`PLAN_LIMIT_EXCEEDED` with `limit`, `used`, `cap`)

No new infrastructure: Cloudflare Worker + Supabase only. Existing API shape is preserved.

---

## Migration Steps

### 1. Apply SQL migration

Run the Plan v2 migration on your Supabase project:

```bash
# From repo root; use your Supabase CLI or run the SQL in the dashboard.
psql $DATABASE_URL -f infra/sql/030_usage_plan_v2.sql
```

**What it does:**

- Adds to `usage_daily`:
  - `extraction_calls` (int, default 0)
  - `embed_tokens_used` (int, default 0)
- Defines RPC `bump_usage_if_within_cap(workspace_id, day, deltas..., caps...)` that:
  - Locks the row, checks all caps, and only increments if within cap
  - Returns one row with `exceeded` and `limit_name` when cap would be exceeded; otherwise updates and returns the new row

### 2. Deploy Worker

Deploy the API Worker after the migration. The Worker already:

- Resolves quota with `resolveQuotaForWorkspace` (plan limits from workspace/entitlements)
- Calls `reserveQuotaAndMaybeRespond` (which uses `bump_usage_if_within_cap`) before any quota-consuming action
- Enforces `max_text_chars`, extraction gating, and workspace RPM

### 3. Backward compatibility

- Existing clients that rely on `CAP_EXCEEDED` or `upgrade_required` should also handle `PLAN_LIMIT_EXCEEDED` and the new `limit` / `used` / `cap` fields.
- The old `bump_usage_rpc` (if still used elsewhere) is unchanged; new paths use only `bump_usage_if_within_cap`.

---

## Plan Limits (Source of truth: `packages/shared/src/plans.ts`)

| Plan    | Price (INR) | writes/day | reads/day | embed_tokens/day | extraction_calls/day | max_text_chars | workspace_rpm |
|---------|-------------|------------|-----------|-------------------|----------------------|----------------|---------------|
| Launch  | 299 / 7d    | 300        | 1,000     | 50,000            | 0                    | 15,000         | 120           |
| Build   | 499 / mo    | 1,000      | 3,000     | 200,000           | 50                   | 15,000         | 120           |
| Deploy  | 1,999 / mo  | 5,000      | 10,000    | 2,000,000         | 300                  | 20,000         | 120           |
| Scale   | 4,999 / mo  | 20,000     | 50,000    | 10,000,000        | 1,000                | 25,000         | 300           |
| Scale+  | custom      | 100,000    | 200,000   | 200,000,000       | 5,000                | 50,000         | 300           |

- **Embed count cap** (backward compatible): `embeds_cap = floor(embed_tokens_per_day / 200)`.
- **Token estimate**: `ceil(text.length / 4)` per chunk/query; both embed count and token sum are enforced.

---

## Enforcement Flows

### POST /v1/memories

1. Resolve quota; if blocked (e.g. entitlement expired) → 402 `ENTITLEMENT_EXPIRED`.
2. Key rate limit → 429 if exceeded.
3. Workspace rate limit (plan’s `workspace_rpm`) → 429 if exceeded.
4. If `text.length > plan.max_text_chars` → 402 `PLAN_LIMIT_EXCEEDED` (limit `max_text_chars`).
5. If `extract === true` and `extraction_calls_per_day === 0` → 402 (limit `extraction_calls`).
6. Chunk text; compute `estimatedEmbedTokens` (sum of `ceil(chunk.length/4)`).
7. **Atomic reserve**: `reserveQuotaAndMaybeRespond(quota, supabase, workspaceId, day, { writesDelta: 1, readsDelta: 0, embedsDelta: chunkCount, embedTokensDelta, extractionCallsDelta: extract ? 1 : 0 })`. If 402, return it.
8. Embed, insert memory and chunks; if extract, run extraction. No separate bump at the end.

### POST /v1/search and POST /v1/context

1. Resolve quota; if blocked → 402.
2. Key rate limit → 429.
3. Workspace rate limit → 429.
4. **Atomic reserve** with `readsDelta: 1`, `embedsDelta: 0|1` (keyword vs hybrid/vector), `embedTokensDelta: estimateEmbedTokens(query.length)`.
5. If 402, emit `cap_exceeded` and return 402.
6. Call `performSearch` (no bump inside; quota already reserved).

### POST /v1/import

1. Decode artifact; resolve `memoriesToWrite` and `chunksToWrite` (after mode logic).
2. Compute deltas: `writesDelta`, `embedsDelta`, `embedTokensDelta` (sum over chunk text lengths).
3. **Atomic reserve** via `preInsertGuard(deltas)`. If guard returns 402 response, return it.
4. Otherwise insert memories and chunks.

### POST /v1/eval/run

1. Load eval set and items; cap items at **100** per run.
2. Compute total deltas (reads, embeds, embed tokens) for the capped run.
3. Resolve quota; workspace rate limit; **atomic reserve** with total deltas.
4. If 402, return it. Otherwise run retrieval for each item (no per-call bump; quota already reserved).

---

## Error Shape

All plan-limit 402 responses use:

```json
{
  "error": {
    "code": "PLAN_LIMIT_EXCEEDED",
    "limit": "writes",
    "used": 300,
    "cap": 300,
    "message": "Plan limit exceeded: writes",
    "upgrade_url": "https://app.example.com/billing"
  }
}
```

`limit` is one of: `writes`, `reads`, `embeds`, `embed_tokens`, `extraction_calls`, `max_text_chars`.

---

## Tests

- **Unit / handler tests**: `apps/api/tests/billing.test.ts`, `apps/api/tests/events.test.ts` (cap and event behavior).
- **Plan v2 integration tests**: `apps/api/tests/plan_v2_caps.test.ts`:
  - Extraction cap (extract=true on Launch → 402)
  - Token cap (embed_tokens over cap → 402)
  - Atomic cap (writes/reads at cap → 402)
  - Import cap (import would exceed → 402)
  - Eval cap (eval run would exceed → 402)
  - Workspace RPM (over limit → 429)
  - Error shape (PLAN_LIMIT_EXCEEDED with limit, used, cap)

---

## Summary of Financial Protections

| Risk / abuse           | Mitigation                                                                 |
|------------------------|----------------------------------------------------------------------------|
| Over-use vs plan       | Single atomic RPC ensures caps are enforced without race conditions        |
| Extraction abuse       | Per-plan `extraction_calls_per_day`; Launch = 0                            |
| Token / embed runaway | `embed_tokens_used` + `embeds` cap; reserve before embed                    |
| Import bulk abuse      | Pre-calc deltas; atomic reserve before any insert                          |
| Eval run abuse         | Items capped at 100; total delta reserved once before run                  |
| Workspace burst        | Workspace RPM (120 / 300) in addition to key rate limit                     |
| Text bloat             | Plan-based `max_text_chars` (15k–50k)                                      |

All of this is enforced in the Worker using the same Supabase RPC and tables; no queues or new services.
