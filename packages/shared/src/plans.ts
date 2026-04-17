/**
 * Single source of truth for platform plans and limits (Plan v2).
 * Used by API (caps, billing) and docs. No internal org/team plans.
 * Financial safety: extraction_calls_per_day, max_text_chars, token-based caps.
 */

export type PlanId = "launch" | "build" | "deploy" | "scale" | "scale_plus";

export interface PlanLimits {
  /** Included writes per billing cycle (compat alias: writes_per_day). */
  included_writes: number;
  /** Included reads per billing cycle (compat alias: reads_per_day). */
  included_reads: number;
  /** Included embed tokens per billing cycle (compat alias: embed_tokens_per_day). */
  included_embed_tokens: number;
  /** Included generation tokens per billing cycle (input + output). */
  included_gen_tokens: number;
  /** Included storage in GB-month. */
  included_storage_gb: number;
  /** Pricing guardrail to prevent day-1 bucket draining. */
  daily_usage_pct_cap: number;
  /** Data retention for this plan. */
  retention_days: number;
  /** Overage rates used by billing v3 tables/functions. */
  overage_writes_per_1k_inr: number;
  overage_reads_per_1k_inr: number;
  overage_embed_tokens_per_1m_inr: number;
  overage_gen_tokens_per_1m_inr: number;
  overage_storage_gb_month_inr: number;
  /** Compatibility alias; same value as included_writes during transition. */
  writes_per_day: number;
  /** Compatibility alias; same value as included_reads during transition. */
  reads_per_day: number;
  /** Hard gate: blocks ingest + search/context when exceeded. */
  /** Compatibility alias; same value as included_embed_tokens during transition. */
  embed_tokens_per_day: number;
  /** 0 = extraction disabled for plan. */
  extraction_calls_per_day: number;
  /** Max characters per memory text (plan-based). */
  max_text_chars: number;
  /** Optional workspace-level RPM (Scale: 300, others: 120). */
  workspace_rpm?: number;
}

export interface Plan {
  id: PlanId;
  label: string;
  /** Positioning for console: "solo" or "team". */
  audience: "solo" | "team" | "legacy";
  /** Seat cap for workspace members. */
  member_cap: number;
  price_inr: number;
  /** 7 for Launch, 30 for Build/Deploy/Scale, null for Scale+ (custom). */
  billing_period_days: number | null;
  limits: PlanLimits;
}

/** Default: 60 req/min per API key. */
export const RATE_LIMIT_RPM_DEFAULT = 60;
/** New keys: 15 req/min for first 48h (implemented via api_keys.created_at in API). */
export const RATE_LIMIT_RPM_NEW_KEY = 15;

/** Workspace-level RPM for non-Scale plans. */
export const WORKSPACE_RPM_DEFAULT = 120;
/** Workspace-level RPM for Scale plan. */
export const WORKSPACE_RPM_SCALE = 300;

/** ~200 tokens per embed (backward-compatible embeds count cap). */
export const TOKENS_PER_EMBED_ASSUMED = 200;

const PLANS: Plan[] = [
  {
    id: "launch",
    label: "Launch",
    audience: "solo",
    member_cap: 1,
    price_inr: 399,
    billing_period_days: 7,
    limits: {
      included_writes: 250,
      included_reads: 1000,
      included_embed_tokens: 100_000,
      included_gen_tokens: 150_000,
      included_storage_gb: 0.5,
      daily_usage_pct_cap: 15,
      retention_days: 30,
      overage_writes_per_1k_inr: 90,
      overage_reads_per_1k_inr: 120,
      overage_embed_tokens_per_1m_inr: 60,
      overage_gen_tokens_per_1m_inr: 220,
      overage_storage_gb_month_inr: 35,
      writes_per_day: 250,
      reads_per_day: 1000,
      embed_tokens_per_day: 100_000,
      extraction_calls_per_day: 0,
      max_text_chars: 12_000,
      workspace_rpm: WORKSPACE_RPM_DEFAULT,
    },
  },
  {
    id: "build",
    label: "Build",
    audience: "solo",
    member_cap: 1,
    price_inr: 999,
    billing_period_days: 30,
    limits: {
      included_writes: 1200,
      included_reads: 4000,
      included_embed_tokens: 600_000,
      included_gen_tokens: 1_000_000,
      included_storage_gb: 2,
      daily_usage_pct_cap: 15,
      retention_days: 90,
      overage_writes_per_1k_inr: 75,
      overage_reads_per_1k_inr: 100,
      overage_embed_tokens_per_1m_inr: 50,
      overage_gen_tokens_per_1m_inr: 180,
      overage_storage_gb_month_inr: 30,
      writes_per_day: 1200,
      reads_per_day: 4000,
      embed_tokens_per_day: 600_000,
      extraction_calls_per_day: 100,
      max_text_chars: 15_000,
      workspace_rpm: WORKSPACE_RPM_DEFAULT,
    },
  },
  {
    id: "deploy",
    label: "Deploy",
    audience: "team",
    member_cap: 10,
    price_inr: 2999,
    billing_period_days: 30,
    limits: {
      included_writes: 5000,
      included_reads: 15_000,
      included_embed_tokens: 3_000_000,
      included_gen_tokens: 5_000_000,
      included_storage_gb: 10,
      daily_usage_pct_cap: 15,
      retention_days: 180,
      overage_writes_per_1k_inr: 60,
      overage_reads_per_1k_inr: 80,
      overage_embed_tokens_per_1m_inr: 40,
      overage_gen_tokens_per_1m_inr: 140,
      overage_storage_gb_month_inr: 25,
      writes_per_day: 5000,
      reads_per_day: 15_000,
      embed_tokens_per_day: 3_000_000,
      extraction_calls_per_day: 500,
      max_text_chars: 20_000,
      workspace_rpm: WORKSPACE_RPM_DEFAULT,
    },
  },
  {
    id: "scale",
    label: "Scale",
    audience: "team",
    member_cap: 10,
    price_inr: 8999,
    billing_period_days: 30,
    limits: {
      included_writes: 20_000,
      included_reads: 60_000,
      included_embed_tokens: 12_000_000,
      included_gen_tokens: 20_000_000,
      included_storage_gb: 50,
      daily_usage_pct_cap: 15,
      retention_days: 365,
      overage_writes_per_1k_inr: 50,
      overage_reads_per_1k_inr: 65,
      overage_embed_tokens_per_1m_inr: 35,
      overage_gen_tokens_per_1m_inr: 110,
      overage_storage_gb_month_inr: 20,
      writes_per_day: 20000,
      reads_per_day: 60_000,
      embed_tokens_per_day: 12_000_000,
      extraction_calls_per_day: 2000,
      max_text_chars: 25_000,
      workspace_rpm: WORKSPACE_RPM_SCALE,
    },
  },
  {
    id: "scale_plus",
    label: "Scale+",
    audience: "legacy",
    member_cap: 25,
    price_inr: 0, // custom
    billing_period_days: null,
    limits: {
      included_writes: 100_000,
      included_reads: 200_000,
      included_embed_tokens: 200_000_000,
      included_gen_tokens: 200_000_000,
      included_storage_gb: 250,
      daily_usage_pct_cap: 20,
      retention_days: 365,
      overage_writes_per_1k_inr: 40,
      overage_reads_per_1k_inr: 55,
      overage_embed_tokens_per_1m_inr: 30,
      overage_gen_tokens_per_1m_inr: 95,
      overage_storage_gb_month_inr: 18,
      writes_per_day: 100000,
      reads_per_day: 200000,
      embed_tokens_per_day: 200_000_000,
      extraction_calls_per_day: 5000,
      max_text_chars: 50_000,
      workspace_rpm: WORKSPACE_RPM_SCALE,
    },
  },
];

export const PLANS_BY_ID: Record<PlanId, Plan> = PLANS.reduce(
  (acc, p) => {
    acc[p.id] = p;
    return acc;
  },
  {} as Record<PlanId, Plan>,
);

/** Plan ids accepted at checkout. Enterprise-like scale_plus is legacy-only. */
export const CHECKOUT_PLAN_IDS: PlanId[] = ["launch", "build", "deploy", "scale"];

export function getPlan(id: PlanId | string | null | undefined): Plan | null {
  if (!id || typeof id !== "string") return null;
  const normalized = id.trim().toLowerCase().replace("scale+", "scale_plus");
  return PLANS_BY_ID[normalized as PlanId] ?? null;
}

/** Default caps for unknown/unrecognized plan codes. Same as Launch tier. */
export function getDefaultCaps(): PlanLimits {
  return PLANS_BY_ID.launch.limits;
}

/**
 * Returns limits for a plan code (launch/build/deploy/scale/scale_plus).
 * For unknown values, returns Launch-like caps.
 */
export function getLimitsForPlanCode(planCode: string | null | undefined): PlanLimits {
  const plan = getPlan(planCode);
  return plan?.limits ?? getDefaultCaps();
}

/**
 * Embeds cap derived from embed_tokens_per_day for backward-compatible usage_daily.embeds counting.
 */
export function embedsCapFromEmbedTokens(embedTokensPerDay: number): number {
  return Math.floor(embedTokensPerDay / TOKENS_PER_EMBED_ASSUMED);
}

/** Usage caps shape for API (writes, reads, embeds count). Used by limits.ts and quota resolution. */
export interface UsageCaps {
  writes: number;
  reads: number;
  embeds: number;
}
import {
  computeCredits,
  type CostModelInput as InternalCreditsInput,
  type CreditsBreakdown as InternalCreditsBreakdown,
  CREDIT_WEIGHTS,
} from "./costModel.js";

export type { InternalCreditsInput, InternalCreditsBreakdown };
export const INTERNAL_CREDIT_WEIGHTS = CREDIT_WEIGHTS;

/** @deprecated Use computeCredits from costModel.ts */
export function computeInternalCredits(input: InternalCreditsInput): {
  total: number;
  breakdown: InternalCreditsBreakdown;
} {
  return computeCredits(input);
}

/** Included internal credits budget implied by plan limits (dual model: credits + INR hard cap). */
export function computePlanIncludedInternalCredits(limits: PlanLimits): {
  total: number;
  breakdown: InternalCreditsBreakdown;
} {
  return computeInternalCredits({
    writes: limits.included_writes ?? limits.writes_per_day,
    reads: limits.included_reads ?? limits.reads_per_day,
    embed_tokens: limits.included_embed_tokens ?? limits.embed_tokens_per_day,
    extraction_calls: limits.extraction_calls_per_day,
    gen_tokens: limits.included_gen_tokens ?? 0,
    storage_gb: limits.included_storage_gb ?? 0,
  });
}

/** Returns UsageCaps for a plan code. Unknown => Launch-like caps. */
export function getUsageCapsForPlanCode(planCode: string | null | undefined): UsageCaps {
  const limits = getLimitsForPlanCode(planCode);
  return {
    writes: limits.writes_per_day,
    reads: limits.reads_per_day,
    embeds: embedsCapFromEmbedTokens(limits.embed_tokens_per_day),
  };
}

/** Returns workspace RPM for plan (Scale/Scale+: 300, others: 120). */
export function getWorkspaceRpmForPlanCode(planCode: string | null | undefined): number {
  const limits = getLimitsForPlanCode(planCode);
  return limits.workspace_rpm ?? WORKSPACE_RPM_DEFAULT;
}
