/**
 * Global AI cost kill switch. When monthly estimated cost exceeds the configured budget,
 * all embedding and LLM operations can be blocked (503) to prevent overspend.
 *
 * Uses a 60-second in-memory cache to avoid DB overhead on every request.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { estimateCostInr } from "@memorynodeai/shared";

/** Thrown when the global AI cost budget is exceeded. Callers should return HTTP 503. */
export class AIBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIBudgetExceededError";
  }
}

/** USD to INR for budget comparison (configurable via env if needed). */
const DEFAULT_USD_TO_INR = 83;
const DEFAULT_COST_DRIFT_MULTIPLIER = 1.35;

const CACHE_TTL_MS = 60_000;

let cachedCostInr: number | null = null;
let cachedAt = 0;
/** When true, a refresh is in progress; other callers should use stale cache to avoid stampede. */
let refreshing = false;

export interface CostGuardEnv {
  AI_COST_BUDGET_INR?: string;
  /** Optional: USD to INR rate for cost estimation (default 83). */
  USD_TO_INR?: string;
  COST_DRIFT_MULTIPLIER?: string;
  ENVIRONMENT?: string;
  NODE_ENV?: string;
  /** Optional emergency override ("1" => fail-open when guard signal is unavailable). */
  AI_COST_GUARD_FAIL_OPEN?: string;
}

function shouldFailClosed(env: CostGuardEnv): boolean {
  if ((env.AI_COST_GUARD_FAIL_OPEN ?? "").trim() === "1") return false;
  const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toLowerCase();
  return stage === "prod" || stage === "production" || stage === "staging";
}

/**
 * Fetch current month's usage from usage_daily and estimate AI cost in INR.
 */
async function getCurrentMonthCostInr(
  supabase: SupabaseClient,
  usdToInr: number,
  driftMultiplier: number,
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
  for (const row of rows ?? []) {
    totalEmbedTokens += Number((row as { embed_tokens_used?: number }).embed_tokens_used ?? 0);
    totalExtractionCalls += Number((row as { extraction_calls?: number }).extraction_calls ?? 0);
  }

  return estimateCostInr(
    {
      embed_tokens: totalEmbedTokens,
      extraction_calls: totalExtractionCalls,
    },
    {
      usd_to_inr: usdToInr,
      drift_multiplier: driftMultiplier,
    },
  );
}

export interface AiCostBudgetSnapshot {
  configured: boolean;
  costInr: number;
  budgetInr: number;
  ratio: number;
  exceeded: boolean;
}

/**
 * Non-throwing snapshot for extraction policy (near-budget degraded mode).
 * Updates the same month-to-date cache as {@link checkGlobalCostGuard} when stale (no mutex; rare double-fetch is OK).
 */
export async function getAiCostBudgetSnapshot(
  supabase: SupabaseClient,
  env: CostGuardEnv,
): Promise<AiCostBudgetSnapshot> {
  const budgetInr = env.AI_COST_BUDGET_INR != null ? Number(env.AI_COST_BUDGET_INR) : NaN;
  if (!Number.isFinite(budgetInr) || budgetInr <= 0) {
    return { configured: false, costInr: 0, budgetInr: 0, ratio: 0, exceeded: false };
  }

  const usdToInr = Number(env.USD_TO_INR) || DEFAULT_USD_TO_INR;
  const driftMultiplier = Number(env.COST_DRIFT_MULTIPLIER ?? DEFAULT_COST_DRIFT_MULTIPLIER);
  const now = Date.now();

  if (cachedCostInr != null && now - cachedAt < CACHE_TTL_MS) {
    const ratio = budgetInr > 0 ? cachedCostInr / budgetInr : 0;
    return {
      configured: true,
      costInr: cachedCostInr,
      budgetInr,
      ratio,
      exceeded: cachedCostInr >= budgetInr,
    };
  }

  try {
    const costInr = await getCurrentMonthCostInr(supabase, usdToInr, driftMultiplier);
    cachedCostInr = costInr;
    cachedAt = now;
    const ratio = budgetInr > 0 ? costInr / budgetInr : 0;
    return {
      configured: true,
      costInr,
      budgetInr,
      ratio,
      exceeded: costInr >= budgetInr,
    };
  } catch {
    if (cachedCostInr != null) {
      const ratio = budgetInr > 0 ? cachedCostInr / budgetInr : 0;
      return {
        configured: true,
        costInr: cachedCostInr,
        budgetInr,
        ratio,
        exceeded: cachedCostInr >= budgetInr,
      };
    }
    return { configured: true, costInr: 0, budgetInr, ratio: 0, exceeded: false };
  }
}

/**
 * If monthly estimated AI cost exceeds the budget, throws AIBudgetExceededError.
 * Callers that must never fail on cost (e.g. POST /v1/memories) should catch this and degrade
 * (e.g. text-only ingest). Other routes may still map this to HTTP 503.
 *
 * Caches result for 60 seconds to avoid DB overhead.
 */
export async function checkGlobalCostGuard(supabase: SupabaseClient, env: CostGuardEnv): Promise<void> {
  const budgetInr = env.AI_COST_BUDGET_INR != null ? Number(env.AI_COST_BUDGET_INR) : NaN;
  if (!Number.isFinite(budgetInr) || budgetInr <= 0) {
    return;
  }

  const usdToInr = Number(env.USD_TO_INR) || DEFAULT_USD_TO_INR;
  const driftMultiplier = Number(env.COST_DRIFT_MULTIPLIER ?? DEFAULT_COST_DRIFT_MULTIPLIER);
  const now = Date.now();
  if (cachedCostInr != null && now - cachedAt < CACHE_TTL_MS) {
    if (cachedCostInr >= budgetInr) {
      throw new AIBudgetExceededError("AI_COST_LIMIT_EXCEEDED");
    }
    return;
  }

  if (refreshing && cachedCostInr != null) {
    if (cachedCostInr >= budgetInr) {
      throw new AIBudgetExceededError("AI_COST_LIMIT_EXCEEDED");
    }
    return;
  }

  refreshing = true;
  try {
    try {
      const costInr = await getCurrentMonthCostInr(supabase, usdToInr, driftMultiplier);
      cachedCostInr = costInr;
      cachedAt = now;
      if (costInr >= budgetInr) {
        throw new AIBudgetExceededError("AI_COST_LIMIT_EXCEEDED");
      }
    } catch (err) {
      if (err instanceof AIBudgetExceededError) {
        throw err;
      }
      if (cachedCostInr != null) {
        if (cachedCostInr >= budgetInr) {
          throw new AIBudgetExceededError("AI_COST_LIMIT_EXCEEDED");
        }
        return;
      }
      if (shouldFailClosed(env)) {
        throw new AIBudgetExceededError("AI_COST_GUARD_UNAVAILABLE");
      }
      return;
    }
  } finally {
    refreshing = false;
  }
}

/** Reset cache (e.g. for tests). */
export function resetCostGuardCache(): void {
  cachedCostInr = null;
  cachedAt = 0;
  refreshing = false;
}
