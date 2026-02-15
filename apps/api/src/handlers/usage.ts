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

export interface UsageRowLike {
  writes: number;
  reads: number;
  embeds: number;
}

export interface QuotaResolutionLike {
  caps: UsageSnapshot;
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
      const rate = await rateLimit(auth.keyHash, env);
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
          plan: effectivePlanValue,
          limits: caps,
        },
        200,
        rate.headers,
      );
    },
  };
}
