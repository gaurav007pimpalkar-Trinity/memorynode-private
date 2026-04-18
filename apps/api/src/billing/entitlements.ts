/**
 * Entitlement plan_code normalization and API-facing effective plan codes.
 * Shared by quota resolution (`workerApp`) and PayU reconciliation.
 */

export type EffectivePlanCode = "launch" | "build" | "deploy" | "scale" | "scale_plus";

export const ENTITLEMENT_DURATION_DAYS: Record<string, number | null> = {
  launch: 7,
  build: 30,
  deploy: 30,
  scale: 30,
  scale_plus: null,
  pro: 30,
};

export function resolveEntitlementPlanCode(raw: string | null | undefined): string {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (!normalized) return "pro";
  if (normalized === "launch") return "launch";
  if (normalized === "build") return "build";
  if (normalized === "deploy") return "deploy";
  if (normalized === "scale") return "scale";
  if (normalized === "scale+" || normalized === "scale_plus") return "scale_plus";
  if (normalized === "pro") return "pro";
  return "pro";
}

export function resolveEntitlementExpiry(planCode: string, now = new Date()): string | null {
  const durationDays = ENTITLEMENT_DURATION_DAYS[planCode] ?? 30;
  if (durationDays === null) return null;
  return new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
}

export function authPlanFromEntitlement(planCode: string): EffectivePlanCode {
  const normalized = resolveEntitlementPlanCode(planCode);
  if (
    normalized === "launch" ||
    normalized === "build" ||
    normalized === "deploy" ||
    normalized === "scale" ||
    normalized === "scale_plus"
  ) {
    return normalized;
  }
  if (normalized === "pro") return "build"; // legacy
  return "launch";
}
