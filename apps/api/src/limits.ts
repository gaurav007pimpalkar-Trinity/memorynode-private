/**
 * Usage caps and rate limits. Plan limits come from @memorynode/shared (single source of truth).
 * Enforcement still uses embeds count; embed_tokens/day is documented and exposed for future hard gate.
 */

import {
  getUsageCapsForPlanCode,
  RATE_LIMIT_RPM_DEFAULT,
  RATE_LIMIT_RPM_NEW_KEY,
  type UsageCaps as SharedUsageCaps,
} from "@memorynode/shared";

export type UsageCaps = SharedUsageCaps;

export const MAX_TEXT_CHARS = 50_000;
export const MAX_QUERY_CHARS = 2_000;
export const DEFAULT_TOPK = 8;
export const MAX_TOPK = 20;

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = RATE_LIMIT_RPM_DEFAULT;

/** Resolve caps by plan code (launch/build/deploy/scale/scale_plus or "free" for unentitled). */
export function capsByPlanCode(planCode: string | null | undefined): UsageCaps {
  return getUsageCapsForPlanCode(planCode);
}

/** Deprecated: legacy free/pro/team mapping retained only for internal fixtures/tests; do not use for new code. Not in OpenAPI or public types. */
export const capsByPlan: Record<"free" | "pro" | "team", UsageCaps> = {
  free: getUsageCapsForPlanCode("free"),
  pro: getUsageCapsForPlanCode("build"),
  team: getUsageCapsForPlanCode("deploy"),
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
