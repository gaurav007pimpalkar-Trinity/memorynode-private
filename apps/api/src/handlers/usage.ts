/**
 * Usage handler (today's usage + quota/limits). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * Dependencies injected via UsageHandlerDeps to avoid circular dependency with index.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import type { UsageSnapshot } from "../limits.js";
import {
  computeInternalCredits,
  computeOperationalMode,
  computePlanIncludedInternalCredits,
  computeUsageCapAlerts,
  type PlanLimits,
} from "@memorynodeai/shared";

export interface UsageRowLike {
  writes: number;
  reads: number;
  embeds: number;
  extraction_calls?: number;
  embed_tokens_used?: number;
  gen_input_tokens_used?: number;
  gen_output_tokens_used?: number;
  storage_bytes_used?: number;
}

export interface QuotaResolutionLike {
  caps: UsageSnapshot;
  planLimits: PlanLimits;
  effectivePlan: string;
  planStatus: AuthContext["planStatus"];
  blocked: boolean;
  errorCode?: string;
  message?: string;
  /** When false and not blocked: entitlement row read failed; vector/search may be restricted in prod. */
  degradedEntitlements?: boolean;
  /** Billing grace row: caps floored toward Launch while `effectivePlan` stays paid. */
  grace_soft_downgrade?: boolean;
  periodStart?: string | null;
  periodEnd?: string | null;
  semantics?: "dual_hard";
}

export interface UsageHandlerDeps extends HandlerDeps {
  todayUtc: () => string;
  rateLimitWorkspace: (workspaceId: string, workspaceRpm: number, env: Env) => Promise<{ allowed: boolean; headers: Record<string, string> }>;
  getUsage: (
    supabase: SupabaseClient,
    workspaceId: string,
    day: string,
  ) => Promise<UsageRowLike>;
  resolveQuotaForWorkspace: (
    auth: AuthContext,
    supabase: SupabaseClient,
  ) => Promise<QuotaResolutionLike>;
}

export function createUsageHandlers(
  requestDeps: UsageHandlerDeps,
  defaultDeps: UsageHandlerDeps,
): {
  handleUsageToday: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleUsageToday(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as UsageHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const day = d.todayUtc();
      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quota.blocked) {
        return jsonResponse(
          {
            error: {
              code: "ENTITLEMENT_REQUIRED",
              message: "No active paid entitlement found. Start a plan to use usage APIs.",
              upgrade_required: true,
              effective_plan: "launch",
            },
            upgrade_url: (env as { PUBLIC_APP_URL?: string }).PUBLIC_APP_URL
              ? `${(env as { PUBLIC_APP_URL: string }).PUBLIC_APP_URL}/billing`
              : undefined,
          },
          402,
          rate.headers,
        );
      }
      const wsRpm = quota.planLimits.workspace_rpm ?? 120;
      const wsRate = await d.rateLimitWorkspace(auth.workspaceId, wsRpm, env);
      if (!wsRate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
          429,
          { ...rate.headers, ...wsRate.headers },
        );
      }
      const rateHeaders = { ...rate.headers, ...wsRate.headers };
      const usage = await d.getUsage(supabase, auth.workspaceId, day);
      const caps = quota.caps;
      const usedCredits = computeInternalCredits({
        writes: usage.writes,
        reads: usage.reads,
        embed_tokens: usage.embed_tokens_used ?? 0,
        extraction_calls: usage.extraction_calls ?? 0,
        gen_tokens: (usage.gen_input_tokens_used ?? 0) + (usage.gen_output_tokens_used ?? 0),
        storage_gb: (usage.storage_bytes_used ?? 0) / 1_000_000_000,
      });
      const includedCredits = computePlanIncludedInternalCredits(quota.planLimits);
      const embedTokensCap = quota.planLimits.included_embed_tokens ?? quota.planLimits.embed_tokens_per_day;
      const genTokensCap = Math.max(0, quota.planLimits.included_gen_tokens ?? 0);
      const storageBytesCap = Math.max(0, (quota.planLimits.included_storage_gb ?? 0) * 1_000_000_000);
      const capAlerts = computeUsageCapAlerts({
        writes: usage.writes,
        reads: usage.reads,
        embeds: usage.embeds,
        embed_tokens: usage.embed_tokens_used ?? 0,
        extraction_calls: usage.extraction_calls ?? 0,
        gen_tokens: (usage.gen_input_tokens_used ?? 0) + (usage.gen_output_tokens_used ?? 0),
        storage_bytes: usage.storage_bytes_used ?? 0,
        caps,
        embed_tokens_cap: embedTokensCap,
        extraction_calls_cap: quota.planLimits.extraction_calls_per_day,
        gen_tokens_cap: genTokensCap,
        storage_bytes_cap: storageBytesCap,
      });
      const operationalMode = computeOperationalMode({
        degradedEntitlements: Boolean(quota.degradedEntitlements),
        capAlerts,
        graceSoftDowngrade: Boolean(quota.grace_soft_downgrade),
      });
      return jsonResponse(
        {
          day,
          writes: usage.writes,
          reads: usage.reads,
          embeds: usage.embeds,
          extraction_calls: usage.extraction_calls ?? 0,
          embed_tokens: usage.embed_tokens_used ?? 0,
          gen_tokens: (usage.gen_input_tokens_used ?? 0) + (usage.gen_output_tokens_used ?? 0),
          storage_bytes: usage.storage_bytes_used ?? 0,
          plan: quota.effectivePlan,
          limits: caps,
          cap_alerts: capAlerts,
          operational_mode: operationalMode,
          ...(quota.grace_soft_downgrade ? { grace_soft_downgrade: true } : {}),
          limits_v3: {
            included_writes: quota.planLimits.included_writes ?? quota.planLimits.writes_per_day,
            included_reads: quota.planLimits.included_reads ?? quota.planLimits.reads_per_day,
            included_embed_tokens: quota.planLimits.included_embed_tokens ?? quota.planLimits.embed_tokens_per_day,
            included_gen_tokens: quota.planLimits.included_gen_tokens ?? 0,
            included_storage_gb: quota.planLimits.included_storage_gb ?? 0,
          },
          internal_credits: {
            model: "v1",
            used_total: usedCredits.total,
            used_breakdown: usedCredits.breakdown,
            included_total: includedCredits.total,
            included_breakdown: includedCredits.breakdown,
          },
          semantics: quota.semantics ?? "dual_hard",
          period: {
            start: quota.periodStart ?? null,
            end: quota.periodEnd ?? null,
            daily_cap: "hard",
            monthly_cap: "hard",
          },
        },
        200,
        rateHeaders,
      );
    },
  };
}
