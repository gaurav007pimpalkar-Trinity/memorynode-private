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
import type { PlanLimits } from "@memorynodeai/shared";

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
}

export interface UsageHandlerDeps extends HandlerDeps {
  todayUtc: () => string;
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
      const usage = await d.getUsage(supabase, auth.workspaceId, day);
      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      const caps = quota.caps;
      const effectivePlanValue = quota.blocked ? "free" : quota.effectivePlan;
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
          plan: effectivePlanValue,
          limits: caps,
          limits_v3: {
            included_writes: quota.planLimits.included_writes ?? quota.planLimits.writes_per_day,
            included_reads: quota.planLimits.included_reads ?? quota.planLimits.reads_per_day,
            included_embed_tokens: quota.planLimits.included_embed_tokens ?? quota.planLimits.embed_tokens_per_day,
            included_gen_tokens: quota.planLimits.included_gen_tokens ?? 0,
            included_storage_gb: quota.planLimits.included_storage_gb ?? 0,
          },
        },
        200,
        rate.headers,
      );
    },
  };
}
