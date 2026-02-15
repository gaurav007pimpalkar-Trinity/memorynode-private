/**
 * Single source of truth for platform plans and limits.
 * Used by API (caps, billing) and docs. No internal org/team plans.
 */

export type PlanId = "launch" | "build" | "deploy" | "scale" | "scale_plus";

export interface PlanLimits {
  writes_per_day: number;
  reads_per_day: number;
  /** Hard gate: blocks ingest + search/context when exceeded. ~200 tokens per embed. */
  embed_tokens_per_day: number;
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
/** New keys first 24–48h: 15 req/min. TODO: Implement reduced RPM for new keys for 48h using api_keys.created_at (DB) or issue_time in key metadata. */
export const RATE_LIMIT_RPM_NEW_KEY = 15;

/** ~200 tokens per embed (docs + future embed_tokens enforcement). */
export const TOKENS_PER_EMBED_ASSUMED = 200;

const PLANS: Plan[] = [
  {
    id: "launch",
    label: "Launch",
    price_inr: 299,
    billing_period_days: 7,
    limits: {
      writes_per_day: 200,
      reads_per_day: 500,
      embed_tokens_per_day: 400_000, // ~2000 embeds
    },
  },
  {
    id: "build",
    label: "Build",
    price_inr: 499,
    billing_period_days: 30,
    limits: {
      writes_per_day: 2000,
      reads_per_day: 5000,
      embed_tokens_per_day: 4_000_000, // ~20k embeds
    },
  },
  {
    id: "deploy",
    label: "Deploy",
    price_inr: 1999,
    billing_period_days: 30,
    limits: {
      writes_per_day: 10000,
      reads_per_day: 20000,
      embed_tokens_per_day: 20_000_000, // ~100k embeds
    },
  },
  {
    id: "scale",
    label: "Scale",
    price_inr: 4999,
    billing_period_days: 30,
    limits: {
      writes_per_day: 30000,
      reads_per_day: 60000,
      embed_tokens_per_day: 60_000_000, // ~300k embeds
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
      embed_tokens_per_day: 200_000_000, // ~1M embeds
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
 * TODO (backlog): Implement embed_tokens/day enforcement by tracking actual tokens from embedding responses (or approximate per request) and blocking ingest/search when exceeded.
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
