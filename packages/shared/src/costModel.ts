export const COST_MODEL_VERSION = "v1";

export const COST_MODEL_CONSTANTS = {
  usd_to_inr_default: 83,
  cost_drift_multiplier_default: 1.35,
  cost_drift_multiplier_max: 3,
  embed_cost_usd_per_1k_tokens: 0.00002,
  extraction_cost_usd_per_call: 0.00015,
  read_db_cost_inr: 0.0005,
  write_db_cost_inr: 0.002,
  gen_cost_usd_per_1k_tokens: 0,
  storage_cost_inr_per_gb: 0,
} as const;

export interface CostModelInput {
  writes?: number;
  reads?: number;
  embed_tokens?: number;
  extraction_calls?: number;
  gen_tokens?: number;
  storage_gb?: number;
}

export interface CostModelOptions {
  usd_to_inr?: number;
  drift_multiplier?: number;
}

export interface CreditsBreakdown {
  writes: number;
  reads: number;
  embed_tokens: number;
  extraction_calls: number;
  gen_tokens: number;
  storage_gb: number;
}

export const CREDIT_WEIGHTS = {
  write: 4,
  read: 1,
  embed_tokens_per_1k: 1,
  extraction_call: 10,
  gen_tokens_per_1k: 2,
  storage_gb: 20,
} as const;

function floorNonNegative(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function normalizeDriftMultiplier(raw: unknown): number {
  const parsed = Number(raw ?? COST_MODEL_CONSTANTS.cost_drift_multiplier_default);
  if (!Number.isFinite(parsed) || parsed <= 1) return COST_MODEL_CONSTANTS.cost_drift_multiplier_default;
  return Math.min(COST_MODEL_CONSTANTS.cost_drift_multiplier_max, parsed);
}

export function computeCredits(input: CostModelInput): {
  total: number;
  breakdown: CreditsBreakdown;
} {
  const writes = floorNonNegative(input.writes);
  const reads = floorNonNegative(input.reads);
  const embedTokens = floorNonNegative(input.embed_tokens);
  const extractionCalls = floorNonNegative(input.extraction_calls);
  const genTokens = floorNonNegative(input.gen_tokens);
  const storageGb = Math.max(0, Number(input.storage_gb ?? 0));

  const breakdown: CreditsBreakdown = {
    writes: writes * CREDIT_WEIGHTS.write,
    reads: reads * CREDIT_WEIGHTS.read,
    embed_tokens: Math.ceil(embedTokens / 1000) * CREDIT_WEIGHTS.embed_tokens_per_1k,
    extraction_calls: extractionCalls * CREDIT_WEIGHTS.extraction_call,
    gen_tokens: Math.ceil(genTokens / 1000) * CREDIT_WEIGHTS.gen_tokens_per_1k,
    storage_gb: Math.ceil(storageGb) * CREDIT_WEIGHTS.storage_gb,
  };
  const total = breakdown.writes +
    breakdown.reads +
    breakdown.embed_tokens +
    breakdown.extraction_calls +
    breakdown.gen_tokens +
    breakdown.storage_gb;
  return { total, breakdown };
}

export function estimateCostInr(input: CostModelInput, options?: CostModelOptions): number {
  const writes = floorNonNegative(input.writes);
  const reads = floorNonNegative(input.reads);
  const embedTokens = floorNonNegative(input.embed_tokens);
  const extractionCalls = floorNonNegative(input.extraction_calls);
  const genTokens = floorNonNegative(input.gen_tokens);
  const storageGb = Math.max(0, Number(input.storage_gb ?? 0));
  const usdToInr = Number(options?.usd_to_inr ?? COST_MODEL_CONSTANTS.usd_to_inr_default);
  const drift = normalizeDriftMultiplier(options?.drift_multiplier);

  const embedCostInr = ((embedTokens / 1000) * COST_MODEL_CONSTANTS.embed_cost_usd_per_1k_tokens) * usdToInr;
  const extractionCostInr = extractionCalls * COST_MODEL_CONSTANTS.extraction_cost_usd_per_call * usdToInr;
  const genCostInr = ((genTokens / 1000) * COST_MODEL_CONSTANTS.gen_cost_usd_per_1k_tokens) * usdToInr;
  const dbCostInr = (reads * COST_MODEL_CONSTANTS.read_db_cost_inr) + (writes * COST_MODEL_CONSTANTS.write_db_cost_inr);
  const storageCostInr = storageGb * COST_MODEL_CONSTANTS.storage_cost_inr_per_gb;
  const raw = embedCostInr + extractionCostInr + genCostInr + dbCostInr + storageCostInr;
  return Number((raw * drift).toFixed(6));
}
