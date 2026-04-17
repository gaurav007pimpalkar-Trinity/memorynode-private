/**
 * Usage caps and rate limits. Plan limits come from @memorynodeai/shared (single source of truth).
 * Enforcement still uses embeds count; embed_tokens/day is documented and exposed for future hard gate.
 */

import {
  getUsageCapsForPlanCode,
  RATE_LIMIT_RPM_DEFAULT,
  RATE_LIMIT_RPM_NEW_KEY,
  type UsageCaps as SharedUsageCaps,
} from "@memorynodeai/shared";

export type UsageCaps = SharedUsageCaps;

/**
 * Max text length allowed in request body (schema validation). Plan-based max_text_chars is enforced in handler and may be lower.
 */
export const MAX_TEXT_CHARS = 50_000;
export const MAX_QUERY_CHARS = 2_000;
export const DEFAULT_TOPK = 8;
export const MAX_TOPK = 20;

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = RATE_LIMIT_RPM_DEFAULT;
export const RATE_LIMIT_SEARCH_MAX = 30;
export const RATE_LIMIT_CONTEXT_MAX = 20;
export const RATE_LIMIT_IMPORT_MAX = 10;
export const RATE_LIMIT_BILLING_MAX = 20;
export const RATE_LIMIT_ADMIN_MAX = 30;
export const RATE_LIMIT_DASHBOARD_SESSION_MAX = 15;

/** New keys use 15 RPM for this long (48h). */
export const NEW_KEY_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * Resolve rate limit max (RPM) for this request. New API keys (created in last 48h) get RATE_LIMIT_RPM_NEW_KEY.
 */
export function getRateLimitMax(
  env: { RATE_LIMIT_MAX?: string },
  keyCreatedAt?: string | null,
): number {
  if (keyCreatedAt) {
    const created = new Date(keyCreatedAt).getTime();
    if (Number.isFinite(created) && Date.now() - created < NEW_KEY_GRACE_MS) {
      return RATE_LIMIT_RPM_NEW_KEY;
    }
  }
  const parsed = Number(env.RATE_LIMIT_MAX ?? RATE_LIMIT_MAX);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : RATE_LIMIT_RPM_DEFAULT;
}

function parseRate(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function getRouteRateLimitMax(
  env: {
    RATE_LIMIT_MAX?: string;
    RATE_LIMIT_SEARCH_MAX?: string;
    RATE_LIMIT_CONTEXT_MAX?: string;
    RATE_LIMIT_IMPORT_MAX?: string;
    RATE_LIMIT_BILLING_MAX?: string;
    RATE_LIMIT_ADMIN_MAX?: string;
    RATE_LIMIT_DASHBOARD_SESSION_MAX?: string;
  },
  route:
    | "default"
    | "search"
    | "context"
    | "import"
    | "billing"
    | "admin"
    | "dashboard_session",
  keyCreatedAt?: string | null,
): number {
  const base = getRateLimitMax(env, keyCreatedAt);
  if (route === "search") return Math.min(base, parseRate(env.RATE_LIMIT_SEARCH_MAX, RATE_LIMIT_SEARCH_MAX));
  if (route === "context") return Math.min(base, parseRate(env.RATE_LIMIT_CONTEXT_MAX, RATE_LIMIT_CONTEXT_MAX));
  if (route === "import") return Math.min(base, parseRate(env.RATE_LIMIT_IMPORT_MAX, RATE_LIMIT_IMPORT_MAX));
  if (route === "billing") return Math.min(base, parseRate(env.RATE_LIMIT_BILLING_MAX, RATE_LIMIT_BILLING_MAX));
  if (route === "admin") return Math.min(base, parseRate(env.RATE_LIMIT_ADMIN_MAX, RATE_LIMIT_ADMIN_MAX));
  if (route === "dashboard_session") {
    return Math.min(base, parseRate(env.RATE_LIMIT_DASHBOARD_SESSION_MAX, RATE_LIMIT_DASHBOARD_SESSION_MAX));
  }
  return base;
}

/** Resolve caps by plan code (launch/build/deploy/scale/scale_plus). */
export function capsByPlanCode(planCode: string | null | undefined): UsageCaps {
  return getUsageCapsForPlanCode(planCode);
}

/** Deprecated: legacy launch/pro/team mapping retained only for internal fixtures/tests; do not use for new code. Not in OpenAPI or public types. */
export const capsByPlan: Record<"launch" | "pro" | "team", UsageCaps> = {
  launch: getUsageCapsForPlanCode("launch"), // Launch: 250, 1000, 500
  pro: getUsageCapsForPlanCode("build"),   // Build: 1000, 3000, 1000
  team: getUsageCapsForPlanCode("deploy"), // Deploy: 5000, 10000, 10000
};

export type UsageSnapshot = { writes: number; reads: number; embeds: number };
export type UsageDelta = { writesDelta: number; readsDelta: number; embedsDelta: number };

export function exceedsCaps(caps: UsageCaps, usage: UsageSnapshot, delta: UsageDelta): boolean {
  const wouldWrites = usage.writes + delta.writesDelta;
  const wouldReads = usage.reads + delta.readsDelta;
  const wouldEmbeds = usage.embeds + delta.embedsDelta;
  return wouldWrites > caps.writes || wouldReads > caps.reads || wouldEmbeds > caps.embeds;
}

export { RATE_LIMIT_RPM_NEW_KEY };
