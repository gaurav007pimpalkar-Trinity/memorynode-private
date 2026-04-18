import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import { authenticate, rateLimit, rateLimitWorkspace } from "../auth.js";
import { getRouteRateLimitMax } from "../limits.js";
import type { HandlerDeps } from "../router.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import type { QuotaResolutionLike } from "./memories.js";

export interface PruningHandlerDeps extends HandlerDeps {
  resolveQuotaForWorkspace: (auth: import("../auth.js").AuthContext, supabase: SupabaseClient) => Promise<QuotaResolutionLike>;
  rateLimitWorkspace: (workspaceId: string, workspaceRpm: number, env: Env) => Promise<{ allowed: boolean; headers: Record<string, string> }>;
}

export function createPruningHandlers(
  requestDeps: PruningHandlerDeps,
  defaultDeps: PruningHandlerDeps,
): {
  handlePruningMetrics: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handlePruningMetrics(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as PruningHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quota.blocked) {
        return jsonResponse(
          {
            error: {
              code: quota.errorCode ?? "ENTITLEMENT_REQUIRED",
              message: quota.message ?? "No active paid entitlement found. Start a plan to continue.",
              upgrade_required: true,
              effective_plan: "launch",
            },
            upgrade_url: (env as { PUBLIC_APP_URL?: string }).PUBLIC_APP_URL
              ? `${(env as { PUBLIC_APP_URL: string }).PUBLIC_APP_URL}/billing`
              : undefined,
          },
          402,
        );
      }
      const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "default", auth.keyCreatedAt));
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
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

      const { data, error } = await supabase.rpc("workspace_pruning_metrics", {
        p_workspace_id: auth.workspaceId,
      });
      if (error) {
        return jsonResponse({ error: { code: "DB_ERROR", message: error.message } }, 500, rateHeaders);
      }
      const row = Array.isArray(data) ? data[0] : data;
      const rec = (row ?? {}) as Record<string, unknown>;
      return jsonResponse(
        {
          memories_total: Number(rec.memories_total ?? 0),
          memories_marked_duplicate: Number(rec.memories_marked_duplicate ?? 0),
          memory_chunks_total: Number(rec.memory_chunks_total ?? 0),
        },
        200,
        rateHeaders,
      );
    },
  };
}
