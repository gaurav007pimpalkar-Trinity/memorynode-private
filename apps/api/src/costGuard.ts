/**
 * Global AI cost kill switch. When monthly estimated cost exceeds the configured budget,
 * all embedding and LLM operations are blocked (503) to prevent overspend.
 *
 * Uses a 60-second in-memory cache to avoid DB overhead on every request.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Thrown when the global AI cost budget is exceeded. Callers should return HTTP 503. */
export class AIBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIBudgetExceededError";
  }
}

/** Rough pricing (USD). text-embedding-3-small: ~$0.00002/1K tokens; gpt-4o-mini extraction: ~$0.00015/call. */
const EMBED_COST_USD_PER_1K_TOKENS = 0.00002;
const EXTRACTION_LLM_COST_USD_PER_CALL = 0.00015;
/** USD to INR for budget comparison (configurable via env if needed). */
const DEFAULT_USD_TO_INR = 83;

const CACHE_TTL_MS = 60_000;

let cachedCostInr: number | null = null;
let cachedAt = 0;

export interface CostGuardEnv {
  AI_COST_BUDGET_INR?: string;
  /** Optional: USD to INR rate for cost estimation (default 83). */
  USD_TO_INR?: string;
}

/**
 * Fetch current month's usage from usage_daily and estimate AI cost in INR.
 * Uses 60-second cache to keep the guard fast.
 */
async function getCurrentMonthCostInr(
  supabase: SupabaseClient,
  usdToInr: number,
): Promise<number> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const firstDay = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const lastDayStr = lastDay.toISOString().slice(0, 10);

  const { data: rows, error } = await supabase
    .from("usage_daily")
    .select("embed_tokens_used, extraction_calls, embeds")
    .gte("day", firstDay)
    .lte("day", lastDayStr);

  if (error) {
    throw new Error(`cost_guard_query_failed: ${error.message}`);
  }

  let totalEmbedTokens = 0;
  let totalExtractionCalls = 0;
  let totalEmbeds = 0;
  for (const row of rows ?? []) {
    totalEmbedTokens += Number((row as { embed_tokens_used?: number }).embed_tokens_used ?? 0);
    totalExtractionCalls += Number((row as { extraction_calls?: number }).extraction_calls ?? 0);
    totalEmbeds += Number((row as { embeds?: number }).embeds ?? 0);
  }

  const embedCostUsd = (totalEmbedTokens / 1000) * EMBED_COST_USD_PER_1K_TOKENS;
  const llmCostUsd = totalExtractionCalls * EXTRACTION_LLM_COST_USD_PER_CALL;
  const costUsd = embedCostUsd + llmCostUsd;
  const costInr = costUsd * usdToInr;
  return costInr;
}

/**
 * If monthly estimated AI cost exceeds the budget, throws AIBudgetExceededError.
 * Callers must catch and return HTTP 503 with body:
 * { "error": "ai_budget_exceeded", "message": "AI usage temporarily paused due to budget protection." }
 *
 * Caches result for 60 seconds to avoid DB overhead.
 */
export async function checkGlobalCostGuard(
  supabase: SupabaseClient,
  env: CostGuardEnv,
): Promise<void> {
  const budgetInr = env.AI_COST_BUDGET_INR != null ? Number(env.AI_COST_BUDGET_INR) : NaN;
  if (!Number.isFinite(budgetInr) || budgetInr <= 0) {
    return;
  }

  const usdToInr = Number(env.USD_TO_INR) || DEFAULT_USD_TO_INR;
  const now = Date.now();
  if (cachedCostInr != null && now - cachedAt < CACHE_TTL_MS) {
    if (cachedCostInr >= budgetInr) {
      throw new AIBudgetExceededError("AI_COST_LIMIT_EXCEEDED");
    }
    return;
  }

  const costInr = await getCurrentMonthCostInr(supabase, usdToInr);
  cachedCostInr = costInr;
  cachedAt = now;

  if (costInr >= budgetInr) {
    throw new AIBudgetExceededError("AI_COST_LIMIT_EXCEEDED");
  }
}

/** Reset cache (e.g. for tests). */
export function resetCostGuardCache(): void {
  cachedCostInr = null;
  cachedAt = 0;
}
