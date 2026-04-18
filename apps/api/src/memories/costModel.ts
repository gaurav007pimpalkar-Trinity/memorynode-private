/**
 * Rough INR estimate for one memory write that includes extraction + child embeds.
 * Used for policy logging and budget proximity — not billing truth.
 */

import { estimateCostInr } from "@memorynodeai/shared";

const DEFAULT_USD_TO_INR = 83;
const DEFAULT_DRIFT = 1.35;

export interface CostModelEnv {
  USD_TO_INR?: string;
  COST_DRIFT_MULTIPLIER?: string;
}

/** ~200 tokens per embed (aligned with handler reserve math). */
const TOKENS_PER_EMBED_ASSUMED = 200;

/**
 * Upper-bound estimate for one extraction pass reserving `maxExtractItems` children
 * with up to `chunksPerChild` embeds each, plus one extraction LLM call.
 */
export function estimateExtractionReserveInr(input: {
  maxExtractItems: number;
  chunksPerChild: number;
  env: CostModelEnv;
}): number {
  const embeds = Math.max(0, input.maxExtractItems) * Math.max(1, input.chunksPerChild);
  const embedTokens = embeds * TOKENS_PER_EMBED_ASSUMED;
  const usdToInr = Number(input.env.USD_TO_INR) || DEFAULT_USD_TO_INR;
  const drift = Number(input.env.COST_DRIFT_MULTIPLIER ?? DEFAULT_DRIFT) || DEFAULT_DRIFT;
  return estimateCostInr(
    { embed_tokens: embedTokens, extraction_calls: 1 },
    { usd_to_inr: usdToInr, drift_multiplier: drift },
  );
}
