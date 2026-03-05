/**
 * Single source of truth for platform plans and limits (Plan v2).
 * Used by API (caps, billing) and docs. No internal org/team plans.
 * Financial safety: extraction_calls_per_day, max_text_chars, token-based caps.
 */

export type PlanId = "launch" | "build" | "deploy" | "scale" | "scale_plus";

export interface PlanLimits {
  writes_per_day: number;
  reads_per_day: number;
  /** Hard gate: blocks ingest + search/context when exceeded. */
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
    price_inr: 299,
    billing_period_days: 7,
    limits: {
      writes_per_day: 300,
      reads_per_day: 1000,
      embed_tokens_per_day: 50_000,
      extraction_calls_per_day: 0,
      max_text_chars: 15_000,
      workspace_rpm: WORKSPACE_RPM_DEFAULT,
    },
  },
  {
    id: "build",
    label: "Build",
    price_inr: 499,
    billing_period_days: 30,
    limits: {
      writes_per_day: 1000,
      reads_per_day: 3000,
      embed_tokens_per_day: 200_000,
      extraction_calls_per_day: 50,
      max_text_chars: 15_000,
      workspace_rpm: WORKSPACE_RPM_DEFAULT,
    },
  },
  {
    id: "deploy",
    label: "Deploy",
    price_inr: 1999,
    billing_period_days: 30,
    limits: {
      writes_per_day: 5000,
      reads_per_day: 10000,
      embed_tokens_per_day: 2_000_000,
      extraction_calls_per_day: 300,
      max_text_chars: 20_000,
      workspace_rpm: WORKSPACE_RPM_DEFAULT,
    },
  },
  {
    id: "scale",
    label: "Scale",
    price_inr: 4999,
    billing_period_days: 30,
    limits: {
      writes_per_day: 20000,
      reads_per_day: 50000,
      embed_tokens_per_day: 10_000_000,
      extraction_calls_per_day: 1000,
      max_text_chars: 25_000,
      workspace_rpm: WORKSPACE_RPM_SCALE,
    },
  },
  {
    id: "scale_plus",
    label: "Scale+",
    price_inr: 0, // custom
    billing_period_days: null,
    limits: {
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

/** Plan ids accepted at checkout. Do not add pro/team; those are legacy internal DB-only labels. */
export const CHECKOUT_PLAN_IDS: PlanId[] = ["launch", "build", "deploy", "scale", "scale_plus"];

export function getPlan(id: PlanId | string | null | undefined): Plan | null {
  if (!id || typeof id !== "string") return null;
  const normalized = id.trim().toLowerCase().replace("scale+", "scale_plus");
  return PLANS_BY_ID[normalized as PlanId] ?? null;
}

/** Caps for unentitled workspace (no active plan). Same as Launch tier. */
export function getFreeCaps(): PlanLimits {
  return PLANS_BY_ID.launch.limits;
}

/**
 * Returns limits for a plan code (launch/build/deploy/scale/scale_plus).
 * For "free" or unknown, returns Launch-like caps.
 */
export function getLimitsForPlanCode(planCode: string | null | undefined): PlanLimits {
  const plan = getPlan(planCode);
  return plan?.limits ?? getFreeCaps();
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

/** Returns UsageCaps for a plan code. "free" or unknown => Launch-like caps. */
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
