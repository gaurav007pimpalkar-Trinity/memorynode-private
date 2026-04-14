/**
 * GET /v1/dashboard/overview-stats — workspace aggregates for the signed-in console (dashboard session or API key).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import { authenticate, rateLimit } from "../auth.js";
import type { AuditCtx, HandlerDeps } from "../router.js";
import { withSupabaseQueryRetry } from "../supabaseRetry.js";

export type OverviewRange = "1d" | "7d" | "30d" | "all";

function parseRange(raw: string | null): OverviewRange {
  if (raw === "1d" || raw === "7d" || raw === "30d" || raw === "all") return raw;
  return "all";
}

/** Rolling window start for memories / chunks (UTC). Null = all time. */
function memoriesSinceIso(range: OverviewRange): string | null {
  if (range === "all") return null;
  const days = range === "1d" ? 1 : range === "7d" ? 7 : 30;
  return new Date(Date.now() - days * 86400000).toISOString();
}

/** Inclusive minimum calendar day for usage_daily (UTC date). Null = all time. */
function usageDayMinDate(range: OverviewRange): string | null {
  if (range === "all") return null;
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const d = now.getUTCDate();
  if (range === "1d") {
    return new Date(Date.UTC(y, mo, d)).toISOString().slice(0, 10);
  }
  const span = range === "7d" ? 6 : 29;
  const start = new Date(Date.UTC(y, mo, d - span));
  return start.toISOString().slice(0, 10);
}

export type DashboardOverviewStats = {
  documents: number;
  memories: number;
  search_requests: number;
  container_tags: number;
};

export function createDashboardOverviewHandlers(
  _requestDeps: HandlerDeps,
  defaultDeps: HandlerDeps,
): {
  handleDashboardOverviewStats: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    url: URL,
    auditCtx: AuditCtx,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleDashboardOverviewStats(request, env, supabase, url, auditCtx, deps?) {
      const d = deps ?? defaultDeps;
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

      const range = parseRange(url.searchParams.get("range"));
      const pMemoriesSince = memoriesSinceIso(range);
      const pUsageDayMin = usageDayMinDate(range);

      const { data, error } = await withSupabaseQueryRetry(async () =>
        supabase.rpc("dashboard_console_overview_stats", {
          p_workspace_id: auth.workspaceId,
          p_memories_since: pMemoriesSince,
          p_usage_day_min: pUsageDayMin,
        }),
      );

      if (error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error.message } },
          500,
          rate.headers,
        );
      }

      let row: Record<string, unknown> | null = null;
      if (data != null && typeof data === "object" && !Array.isArray(data)) {
        row = data as Record<string, unknown>;
      } else if (typeof data === "string") {
        try {
          row = JSON.parse(data) as Record<string, unknown>;
        } catch {
          row = null;
        }
      }
      const stats: DashboardOverviewStats = {
        documents: Number(row?.documents ?? 0) || 0,
        memories: Number(row?.memories ?? 0) || 0,
        search_requests: Number(row?.search_requests ?? 0) || 0,
        container_tags: Number(row?.container_tags ?? 0) || 0,
      };

      return jsonResponse({ range, ...stats }, 200, rate.headers);
    },
  };
}
