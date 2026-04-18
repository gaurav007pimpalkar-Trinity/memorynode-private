/**
 * Workspace entitlement → daily caps / plan limits for authenticated API routes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getLimitsForPlanCode,
  applyLaunchFloorToPlanLimits,
  minUsageCaps,
  embedsCapFromEmbedTokens,
  type PlanLimits,
} from "@memorynodeai/shared";
import type { AuthContext } from "../auth.js";
import {
  authPlanFromEntitlement,
  resolveEntitlementPlanCode,
  type EffectivePlanCode,
} from "../billing/entitlements.js";
import { capsByPlanCode, type UsageSnapshot } from "../limits.js";

export type QuotaResolution =
  | {
      caps: UsageSnapshot;
      planLimits: PlanLimits;
      effectivePlan: EffectivePlanCode;
      planStatus: AuthContext["planStatus"];
      blocked: false;
      degradedEntitlements: boolean;
      /** Paid plan label preserved while daily caps are floored toward Launch. */
      grace_soft_downgrade?: boolean;
      periodStart?: string | null;
      periodEnd?: string | null;
      semantics?: "dual_hard";
    }
  | {
      caps: UsageSnapshot;
      planLimits: PlanLimits;
      effectivePlan: EffectivePlanCode;
      planStatus: AuthContext["planStatus"];
      blocked: true;
      errorCode: "ENTITLEMENT_EXPIRED" | "ENTITLEMENT_REQUIRED";
      message: string;
      expiredAt: string | null;
      periodStart?: string | null;
      periodEnd?: string | null;
      semantics?: "dual_hard";
    };

function normalizeUsageCaps(raw: unknown): UsageSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const writes = Number((raw as Record<string, unknown>).writes);
  const reads = Number((raw as Record<string, unknown>).reads);
  const embeds = Number((raw as Record<string, unknown>).embeds);
  if (![writes, reads, embeds].every((v) => Number.isFinite(v) && v >= 0)) return null;
  return {
    writes: Math.floor(writes),
    reads: Math.floor(reads),
    embeds: Math.floor(embeds),
  };
}

function resolveCapsByEntitlementPlan(planCode: string): UsageSnapshot {
  return capsByPlanCode(resolveEntitlementPlanCode(planCode));
}

function entitlementRowInEffectWindow(row: { starts_at?: string | null; expires_at?: string | null }, now: number): boolean {
  const startsAt = row.starts_at ? Date.parse(row.starts_at) : 0;
  if (Number.isFinite(startsAt) && startsAt > now) return false;
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Number.POSITIVE_INFINITY;
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

export async function resolveQuotaForWorkspace(
  auth: AuthContext,
  supabase: SupabaseClient,
): Promise<QuotaResolution> {
  const fallbackCaps = capsByPlanCode("launch");
  const fallbackPlanLimits = getLimitsForPlanCode("launch");
  const fallbackPlan: EffectivePlanCode = "launch";
  const fallbackStatus = auth.planStatus ?? "past_due";
  const now = Date.now();
  try {
    const query = await supabase
      .from("workspace_entitlements")
      .select("plan_code,status,starts_at,expires_at,caps_json")
      .eq("workspace_id", auth.workspaceId)
      .order("created_at", { ascending: false })
      .limit(25);
    if (query.error) {
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: fallbackPlan,
        planStatus: fallbackStatus,
        blocked: false,
        degradedEntitlements: true,
        semantics: "dual_hard",
      };
    }
    const rows = (query.data ?? []) as Array<{
      plan_code?: string | null;
      status?: string | null;
      starts_at?: string | null;
      expires_at?: string | null;
      caps_json?: unknown;
    }>;
    if (rows.length === 0) {
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: fallbackPlan,
        planStatus: "past_due",
        blocked: true,
        errorCode: "ENTITLEMENT_REQUIRED",
        message: "No active paid entitlement found. Start a plan to use API endpoints.",
        expiredAt: null,
        semantics: "dual_hard",
      };
    }

    const active = rows.find((row) => {
      const status = (row.status ?? "").toLowerCase();
      if (status !== "active") return false;
      return entitlementRowInEffectWindow(row, now);
    });
    if (active) {
      const planCode = resolveEntitlementPlanCode(active.plan_code);
      const caps = normalizeUsageCaps(active.caps_json) ?? resolveCapsByEntitlementPlan(planCode);
      return {
        caps,
        planLimits: getLimitsForPlanCode(planCode),
        effectivePlan: authPlanFromEntitlement(planCode),
        planStatus: "active",
        blocked: false,
        degradedEntitlements: false,
        periodStart: active.starts_at ?? null,
        periodEnd: active.expires_at ?? null,
        semantics: "dual_hard",
      };
    }

    const grace = rows.find((row) => {
      const status = (row.status ?? "").toLowerCase();
      if (status !== "grace") return false;
      return entitlementRowInEffectWindow(row, now);
    });
    if (grace) {
      const planCode = resolveEntitlementPlanCode(grace.plan_code);
      const paidLimits = getLimitsForPlanCode(planCode);
      const planLimits = applyLaunchFloorToPlanLimits(paidLimits);
      const capsFromFlooredPlan: UsageSnapshot = {
        writes: planLimits.writes_per_day,
        reads: planLimits.reads_per_day,
        embeds: embedsCapFromEmbedTokens(planLimits.embed_tokens_per_day),
      };
      const baseCaps = normalizeUsageCaps(grace.caps_json) ?? resolveCapsByEntitlementPlan(planCode);
      const caps = minUsageCaps(baseCaps, capsFromFlooredPlan);
      return {
        caps,
        planLimits,
        effectivePlan: authPlanFromEntitlement(planCode),
        planStatus: "past_due",
        blocked: false,
        degradedEntitlements: false,
        grace_soft_downgrade: true,
        periodStart: grace.starts_at ?? null,
        periodEnd: grace.expires_at ?? null,
        semantics: "dual_hard",
      };
    }

    const expired = rows.find((row) => {
      const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Number.NaN;
      return Number.isFinite(expiresAt) && expiresAt <= now;
    });
    if (expired) {
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: "launch",
        planStatus: "canceled",
        blocked: true,
        errorCode: "ENTITLEMENT_EXPIRED",
        message: "Active entitlement expired. Renew to continue quota-consuming API calls.",
        expiredAt: expired.expires_at ?? null,
        semantics: "dual_hard",
      };
    }
  } catch {
    // Best-effort compatibility with test stubs or pre-migration schemas.
  }
  return {
    caps: fallbackCaps,
    planLimits: fallbackPlanLimits,
    effectivePlan: fallbackPlan,
    planStatus: "past_due",
    blocked: true,
    errorCode: "ENTITLEMENT_REQUIRED",
    message: "Unable to verify active entitlement. Please complete billing before using API endpoints.",
    expiredAt: null,
    semantics: "dual_hard",
  };
}
