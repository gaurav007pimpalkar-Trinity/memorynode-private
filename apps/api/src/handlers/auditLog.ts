/**
 * Tenant-scoped API request audit trail (reads from api_audit_log).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit } from "../auth.js";
import type { AuditCtx, HandlerDeps } from "../router.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import { getRouteRateLimitMax } from "../limits.js";
import type { QuotaResolutionLike } from "./usage.js";

const AUDIT_SELECT =
  "id,route,method,status,bytes_in,bytes_out,latency_ms,ip_hash,api_key_id,created_at";

const MAX_PAGE = 100;
const MAX_LIMIT = 200;

export interface AuditLogHandlerDeps extends HandlerDeps {
  rateLimitWorkspace: (workspaceId: string, workspaceRpm: number, env: Env) => Promise<{ allowed: boolean; headers: Record<string, string> }>;
  resolveQuotaForWorkspace: (auth: AuthContext, supabase: SupabaseClient) => Promise<QuotaResolutionLike>;
}

export function createAuditLogHandlers(
  requestDeps: AuditLogHandlerDeps,
  defaultDeps: AuditLogHandlerDeps,
): {
  handleListAuditLog: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    url: URL,
    auditCtx: AuditCtx,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleListAuditLog(request, env, supabase, url, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as AuditLogHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      auditCtx.workspaceId = auth.workspaceId;
      requireWorkspaceId(auth.workspaceId);

      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quota.blocked) {
        return jsonResponse(
          {
            error: {
              code: quota.errorCode ?? "ENTITLEMENT_REQUIRED",
              message: quota.message ?? "No active paid entitlement found. Start a plan to use audit APIs.",
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
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
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

      const pageRaw = Number(url.searchParams.get("page") ?? "1");
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const page = Number.isFinite(pageRaw) ? Math.min(Math.max(Math.floor(pageRaw), 1), MAX_PAGE) : 1;
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), MAX_LIMIT) : 50;
      const from = (page - 1) * limit;
      const to = from + limit - 1;

      const { data, error } = await supabase
        .from("api_audit_log")
        .select(AUDIT_SELECT)
        .eq("workspace_id", auth.workspaceId)
        .order("created_at", { ascending: false })
        .range(from, to);

      if (error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error.message ?? "Failed to list audit log" } },
          500,
          rateHeaders,
        );
      }

      const rows = Array.isArray(data) ? data : [];
      return jsonResponse(
        {
          entries: rows,
          page,
          limit,
          has_more: rows.length === limit,
        },
        200,
        rateHeaders,
      );
    },
  };
}
