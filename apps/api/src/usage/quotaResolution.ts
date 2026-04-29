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
import type { Env } from "../env.js";
import {
  authPlanFromEntitlement,
  resolveEntitlementPlanCode,
  type EffectivePlanCode,
} from "../billing/entitlements.js";
import { capsByPlanCode, type UsageSnapshot } from "../limits.js";
import { logger } from "../logger.js";

type EntitlementSource = "billing" | "internal_grant";
type InternalGrantMode = "global" | "workspace" | "off";

export type QuotaResolution =
  | {
      caps: UsageSnapshot;
      planLimits: PlanLimits;
      effectivePlan: EffectivePlanCode;
      planStatus: AuthContext["planStatus"];
      blocked: false;
      degradedEntitlements: boolean;
      entitlementActive: true;
      entitlementSource: EntitlementSource;
      internalWorkspace: boolean;
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
      entitlementActive: false;
      entitlementSource: EntitlementSource;
      internalWorkspace: boolean;
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

function normalizeEntitlementSource(value: unknown): EntitlementSource {
  return String(value ?? "").toLowerCase() === "internal_grant" ? "internal_grant" : "billing";
}

function runtimeEnvFallback(): { ENVIRONMENT?: string; NODE_ENV?: string; ALLOW_INTERNAL_GRANTS?: string } {
  return (
    globalThis as {
      __MEMORYNODE_RUNTIME_ENV__?: { ENVIRONMENT?: string; NODE_ENV?: string; ALLOW_INTERNAL_GRANTS?: string };
    }
  ).__MEMORYNODE_RUNTIME_ENV__ ?? {};
}

function resolveInternalGrantMode(env?: Env): InternalGrantMode {
  const runtime = runtimeEnvFallback();
  const raw = (env?.ALLOW_INTERNAL_GRANTS ?? runtime.ALLOW_INTERNAL_GRANTS ?? "true").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return "off";
  if (raw === "workspace") return "workspace";
  return "global";
}

function isProductionPublic(env?: Env): boolean {
  const runtime = runtimeEnvFallback();
  const stage = (env?.ENVIRONMENT ?? env?.NODE_ENV ?? runtime.ENVIRONMENT ?? runtime.NODE_ENV ?? "").trim().toLowerCase();
  return stage === "production_public";
}

function internalGrantPlanFromAuth(auth: AuthContext): EffectivePlanCode {
  return auth.plan === "team" ? "scale" : "build";
}

function logEntitlementDecision(input: {
  workspaceId: string;
  internal: boolean;
  entitlementSource: EntitlementSource;
  result: "granted" | "denied";
  reason: string;
}): void {
  logger.info({
    event: "entitlement_check",
    workspace_id: input.workspaceId,
    internal: input.internal,
    entitlement_source: input.entitlementSource,
    result: input.result,
    reason: input.reason,
  });
}

export async function resolveQuotaForWorkspace(
  auth: AuthContext,
  supabase: SupabaseClient,
  env?: Env,
): Promise<QuotaResolution> {
  const fallbackCaps = capsByPlanCode("launch");
  const fallbackPlanLimits = getLimitsForPlanCode("launch");
  const fallbackPlan: EffectivePlanCode = "launch";
  const fallbackStatus = auth.planStatus ?? "past_due";
  let internalWorkspace = false;
  let internalGrantEnabled = false;
  let entitlementSource: EntitlementSource = "billing";
  const internalGrantMode = resolveInternalGrantMode(env);
  const now = Date.now();

  try {
    const workspaceLookup = await supabase
      .from("workspaces")
      .select("internal, entitlement_source, internal_grant_enabled")
      .eq("id", auth.workspaceId)
      .maybeSingle();
    if (!workspaceLookup.error && workspaceLookup.data) {
      internalWorkspace = workspaceLookup.data.internal === true;
      entitlementSource = normalizeEntitlementSource(workspaceLookup.data.entitlement_source);
      internalGrantEnabled = workspaceLookup.data.internal_grant_enabled === true;
    }
  } catch {
    // Keep fallback defaults for compatibility.
  }

  if (entitlementSource === "internal_grant") {
    if (!internalWorkspace) {
      logEntitlementDecision({
        workspaceId: auth.workspaceId,
        internal: internalWorkspace,
        entitlementSource,
        result: "denied",
        reason: "internal_grant_requires_internal_workspace",
      });
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: fallbackPlan,
        planStatus: "past_due",
        blocked: true,
        errorCode: "ENTITLEMENT_REQUIRED",
        message: "No active paid entitlement found. Start a plan to use API endpoints.",
        entitlementActive: false,
        entitlementSource,
        internalWorkspace,
        expiredAt: null,
        semantics: "dual_hard",
      };
    }
    if (isProductionPublic(env)) {
      logEntitlementDecision({
        workspaceId: auth.workspaceId,
        internal: internalWorkspace,
        entitlementSource,
        result: "denied",
        reason: "internal_grant_disabled_in_production_public",
      });
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: fallbackPlan,
        planStatus: "past_due",
        blocked: true,
        errorCode: "ENTITLEMENT_REQUIRED",
        message: "No active paid entitlement found. Start a plan to use API endpoints.",
        entitlementActive: false,
        entitlementSource,
        internalWorkspace,
        expiredAt: null,
        semantics: "dual_hard",
      };
    }
    if (internalGrantMode === "off") {
      logEntitlementDecision({
        workspaceId: auth.workspaceId,
        internal: internalWorkspace,
        entitlementSource,
        result: "denied",
        reason: "internal_grant_mode_off",
      });
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: fallbackPlan,
        planStatus: "past_due",
        blocked: true,
        errorCode: "ENTITLEMENT_REQUIRED",
        message: "No active paid entitlement found. Start a plan to use API endpoints.",
        entitlementActive: false,
        entitlementSource,
        internalWorkspace,
        expiredAt: null,
        semantics: "dual_hard",
      };
    }
    if (internalGrantMode === "workspace" && !internalGrantEnabled) {
      logEntitlementDecision({
        workspaceId: auth.workspaceId,
        internal: internalWorkspace,
        entitlementSource,
        result: "denied",
        reason: "internal_grant_mode_workspace_not_enabled",
      });
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: fallbackPlan,
        planStatus: "past_due",
        blocked: true,
        errorCode: "ENTITLEMENT_REQUIRED",
        message: "No active paid entitlement found. Start a plan to use API endpoints.",
        entitlementActive: false,
        entitlementSource,
        internalWorkspace,
        expiredAt: null,
        semantics: "dual_hard",
      };
    }
    const grantPlan = internalGrantPlanFromAuth(auth);
    logEntitlementDecision({
      workspaceId: auth.workspaceId,
      internal: internalWorkspace,
      entitlementSource,
      result: "granted",
      reason: internalGrantMode === "workspace" ? "internal_grant_workspace_override_enabled" : "internal_grant_enabled",
    });
    return {
      caps: capsByPlanCode(grantPlan),
      planLimits: getLimitsForPlanCode(grantPlan),
      effectivePlan: authPlanFromEntitlement(grantPlan),
      planStatus: "active",
      blocked: false,
      degradedEntitlements: false,
      entitlementActive: true,
      entitlementSource,
      internalWorkspace,
      semantics: "dual_hard",
    };
  }

  try {
    const query = await supabase
      .from("workspace_entitlements")
      .select("plan_code,status,starts_at,expires_at,caps_json")
      .eq("workspace_id", auth.workspaceId)
      .order("created_at", { ascending: false })
      .limit(25);
    if (query.error) {
      logEntitlementDecision({
        workspaceId: auth.workspaceId,
        internal: internalWorkspace,
        entitlementSource,
        result: "granted",
        reason: "billing_entitlement_lookup_error_fail_open",
      });
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: fallbackPlan,
        planStatus: fallbackStatus,
        blocked: false,
        degradedEntitlements: true,
        entitlementActive: true,
        entitlementSource,
        internalWorkspace,
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
      logEntitlementDecision({
        workspaceId: auth.workspaceId,
        internal: internalWorkspace,
        entitlementSource,
        result: "denied",
        reason: "billing_no_entitlement_rows",
      });
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: fallbackPlan,
        planStatus: "past_due",
        blocked: true,
        errorCode: "ENTITLEMENT_REQUIRED",
        message: "No active paid entitlement found. Start a plan to use API endpoints.",
        entitlementActive: false,
        entitlementSource,
        internalWorkspace,
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
      logEntitlementDecision({
        workspaceId: auth.workspaceId,
        internal: internalWorkspace,
        entitlementSource,
        result: "granted",
        reason: "billing_active_entitlement",
      });
      return {
        caps,
        planLimits: getLimitsForPlanCode(planCode),
        effectivePlan: authPlanFromEntitlement(planCode),
        planStatus: "active",
        blocked: false,
        degradedEntitlements: false,
        entitlementActive: true,
        entitlementSource,
        internalWorkspace,
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
      logEntitlementDecision({
        workspaceId: auth.workspaceId,
        internal: internalWorkspace,
        entitlementSource,
        result: "granted",
        reason: "billing_grace_window",
      });
      return {
        caps,
        planLimits,
        effectivePlan: authPlanFromEntitlement(planCode),
        planStatus: "past_due",
        blocked: false,
        degradedEntitlements: false,
        entitlementActive: true,
        entitlementSource,
        internalWorkspace,
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
      logEntitlementDecision({
        workspaceId: auth.workspaceId,
        internal: internalWorkspace,
        entitlementSource,
        result: "denied",
        reason: "billing_entitlement_expired",
      });
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: "launch",
        planStatus: "canceled",
        blocked: true,
        errorCode: "ENTITLEMENT_EXPIRED",
        message: "Active entitlement expired. Renew to continue quota-consuming API calls.",
        entitlementActive: false,
        entitlementSource,
        internalWorkspace,
        expiredAt: expired.expires_at ?? null,
        semantics: "dual_hard",
      };
    }
  } catch {
    // Best-effort compatibility with test stubs or pre-migration schemas.
  }
  logEntitlementDecision({
    workspaceId: auth.workspaceId,
    internal: internalWorkspace,
    entitlementSource,
    result: "denied",
    reason: "billing_resolution_fallback_denied",
  });
  return {
    caps: fallbackCaps,
    planLimits: fallbackPlanLimits,
    effectivePlan: fallbackPlan,
    planStatus: "past_due",
    blocked: true,
    errorCode: "ENTITLEMENT_REQUIRED",
    message: "Unable to verify active entitlement. Please complete billing before using API endpoints.",
    entitlementActive: false,
    entitlementSource,
    internalWorkspace,
    expiredAt: null,
    semantics: "dual_hard",
  };
}
