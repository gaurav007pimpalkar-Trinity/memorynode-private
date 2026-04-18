/**
 * Plan- and budget-aware extraction gate for POST /v1/memories.
 * Never throws — callers use status to decide reservation sizes and whether to call the LLM.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanLimits } from "@memorynodeai/shared";
import type { Env } from "../env.js";
import { checkGlobalCostGuard, AIBudgetExceededError, getAiCostBudgetSnapshot } from "../costGuard.js";
import { logger } from "../logger.js";
import { estimateExtractionReserveInr } from "./costModel.js";

export type ExtractionPolicyStatus = "run" | "degraded" | "skipped";

export type ExtractionSkipReason =
  | "user_disabled"
  | "low_importance"
  | "plan_limit"
  | "entitlement_degraded"
  | "budget_limit"
  | "none";

export const EXTRACTION_MAX_ITEMS_FULL = 10;
export const EXTRACTION_MAX_ITEMS_DEGRADED = 3;

const MIN_TEXT_LEN_FOR_EXTRACTION = 24;
const DEGRADED_TEXT_LEN_THRESHOLD = 200;
/** When month-to-date AI spend crosses this fraction of the global budget, cap extraction batch size. */
const NEAR_BUDGET_RATIO = 0.82;

export function scoreTextImportance(
  text: string,
  metadata?: Record<string, string | number | boolean | null>,
  memoryType?: string,
): number {
  let score = Math.min(100, Math.floor(text.length / 4));
  const metaKeys = metadata ? Object.keys(metadata).length : 0;
  score += Math.min(30, metaKeys * 5);
  if (text.includes("?") || text.includes("!")) score += 5;
  if (memoryType && memoryType.trim() !== "") score += 4;
  return score;
}

export interface DecideExtractionInput {
  extractRequested: boolean;
  text: string;
  metadata?: Record<string, string | number | boolean | null>;
  /** Optional memory type from the insert payload (slightly boosts importance). */
  memory_type?: string;
  planCode: string;
  planLimits: PlanLimits;
  degradedEntitlements: boolean;
  enforceDegradedBlocks: boolean;
  supabase: SupabaseClient;
  env: Env;
  requestId?: string;
}

export interface DecideExtractionResult {
  status: ExtractionPolicyStatus;
  reason: ExtractionSkipReason;
  maxExtractItems: number;
}

export async function decideExtraction(input: DecideExtractionInput): Promise<DecideExtractionResult> {
  const rid = input.requestId?.trim() || "";

  try {
    if (!input.extractRequested) {
      return { status: "skipped", reason: "user_disabled", maxExtractItems: 0 };
    }

    if (input.degradedEntitlements && input.enforceDegradedBlocks) {
      logger.info({
        event: "extraction_skipped",
        request_id: rid,
        reason: "entitlement_degraded",
      });
      return { status: "skipped", reason: "entitlement_degraded", maxExtractItems: 0 };
    }

    if (input.planLimits.extraction_calls_per_day <= 0) {
      logger.info({
        event: "extraction_skipped",
        request_id: rid,
        reason: "plan_limit",
        plan_code: input.planCode,
      });
      return { status: "skipped", reason: "plan_limit", maxExtractItems: 0 };
    }

    const importance = scoreTextImportance(input.text, input.metadata, input.memory_type);
    const minImportance =
      input.planCode === "scale" || input.planCode === "scale_plus" ? 8 : 12;
    if (importance < minImportance || input.text.trim().length < MIN_TEXT_LEN_FOR_EXTRACTION) {
      logger.info({
        event: "extraction_skipped",
        request_id: rid,
        reason: "low_importance",
        importance_score: importance,
      });
      return { status: "skipped", reason: "low_importance", maxExtractItems: 0 };
    }

    const budgetSnap = await getAiCostBudgetSnapshot(input.supabase, input.env);
    if (budgetSnap.configured && budgetSnap.exceeded) {
      logger.info({
        event: "extraction_skipped",
        request_id: rid,
        reason: "budget_limit",
        budget_ratio: budgetSnap.ratio,
      });
      return { status: "skipped", reason: "budget_limit", maxExtractItems: 0 };
    }

    if (
      budgetSnap.configured &&
      !budgetSnap.exceeded &&
      budgetSnap.ratio >= NEAR_BUDGET_RATIO
    ) {
      const reserveInr = estimateExtractionReserveInr({
        maxExtractItems: EXTRACTION_MAX_ITEMS_DEGRADED,
        chunksPerChild: 2,
        env: input.env,
      });
      logger.info({
        event: "extraction_degraded",
        request_id: rid,
        reason: "none",
        max_extract_items: EXTRACTION_MAX_ITEMS_DEGRADED,
        budget_ratio: budgetSnap.ratio,
        estimated_reserve_inr: reserveInr,
        trigger: "near_budget",
      });
      return {
        status: "degraded",
        reason: "none",
        maxExtractItems: EXTRACTION_MAX_ITEMS_DEGRADED,
      };
    }

    try {
      await checkGlobalCostGuard(input.supabase, input.env);
    } catch (e) {
      if (e instanceof AIBudgetExceededError) {
        logger.info({
          event: "extraction_skipped",
          request_id: rid,
          reason: "budget_limit",
        });
        return { status: "skipped", reason: "budget_limit", maxExtractItems: 0 };
      }
      logger.info({
        event: "extraction_skipped",
        request_id: rid,
        reason: "budget_limit",
        err: e instanceof Error ? e.message : String(e),
      });
      return { status: "skipped", reason: "budget_limit", maxExtractItems: 0 };
    }

    const degradedByLength =
      input.text.length < DEGRADED_TEXT_LEN_THRESHOLD &&
      (input.planCode === "launch" || input.planCode === "build");

    if (degradedByLength) {
      logger.info({
        event: "extraction_degraded",
        request_id: rid,
        reason: "none",
        max_extract_items: EXTRACTION_MAX_ITEMS_DEGRADED,
        trigger: "short_text_plan",
      });
      return {
        status: "degraded",
        reason: "none",
        maxExtractItems: EXTRACTION_MAX_ITEMS_DEGRADED,
      };
    }

    const reserveInr = estimateExtractionReserveInr({
      maxExtractItems: EXTRACTION_MAX_ITEMS_FULL,
      chunksPerChild: 2,
      env: input.env,
    });
    logger.info({
      event: "extraction_attempted",
      request_id: rid,
      max_extract_items: EXTRACTION_MAX_ITEMS_FULL,
      estimated_reserve_inr: reserveInr,
    });
    return { status: "run", reason: "none", maxExtractItems: EXTRACTION_MAX_ITEMS_FULL };
  } catch (e) {
    logger.info({
      event: "extraction_skipped",
      request_id: rid,
      reason: "budget_limit",
      err: e instanceof Error ? e.message : String(e),
    });
    return { status: "skipped", reason: "budget_limit", maxExtractItems: 0 };
  }
}
