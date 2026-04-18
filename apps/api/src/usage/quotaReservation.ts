/**
 * Atomic usage reservation + commit/refund helpers (Worker request path).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeInternalCredits, estimateCostInr, type PlanLimits } from "@memorynodeai/shared";
import type { Env } from "../env.js";
import { createHttpError } from "../http.js";

export function buildUpgradeUrl(env: Env): string {
  if (env.PUBLIC_APP_URL) {
    try {
      return new URL("/billing", env.PUBLIC_APP_URL).toString();
    } catch {
      /* ignore invalid URL */
    }
  }
  return "/billing";
}

export function planLimitExceededResponse(
  limit: string,
  used: number,
  cap: number,
  rateHeaders: Record<string, string> | undefined,
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
  env: Env,
): Response {
  const monthly = limit === "budget";
  const message = monthly
    ? "Monthly billing-period cap exceeded."
    : "Daily fair-use cap exceeded.";
  return jsonResponse(
    {
      error: {
        code: monthly ? "monthly_cap_exceeded" : "daily_cap_exceeded",
        limit,
        used,
        cap,
        message,
        ...(monthly ? { action: "upgrade_required" } : { retry_after: "next_day" }),
        upgrade_url: buildUpgradeUrl(env),
      },
    },
    402,
    rateHeaders,
  );
}

export function estimateRequestCostInr(
  deltas: {
    writesDelta: number;
    readsDelta: number;
    embedTokensDelta: number;
    extractionCallsDelta: number;
  },
  env: Env,
): number {
  return estimateCostInr(
    {
      writes: deltas.writesDelta,
      reads: deltas.readsDelta,
      embed_tokens: deltas.embedTokensDelta,
      extraction_calls: deltas.extractionCallsDelta,
    },
    {
      usd_to_inr: Number(env.USD_TO_INR),
      drift_multiplier: Number(env.COST_DRIFT_MULTIPLIER),
    },
  );
}

export async function reserveQuotaAndMaybeRespond(
  quota: { planLimits: PlanLimits; blocked: boolean },
  supabase: SupabaseClient,
  workspaceId: string,
  day: string,
  deltas: {
    writesDelta: number;
    readsDelta: number;
    embedsDelta: number;
    embedTokensDelta: number;
    extractionCallsDelta: number;
  },
  rateHeaders: Record<string, string> | undefined,
  env: Env,
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
  meta?: { route?: string; requestId?: string },
): Promise<{ response: Response | null; reservationId: string | null }> {
  if (quota.blocked) return { response: null, reservationId: null };
  const requestId = meta?.requestId?.trim() || crypto.randomUUID();
  const caps = {
    writes: quota.planLimits.writes_per_day,
    reads: quota.planLimits.reads_per_day,
    embeds: Math.floor(quota.planLimits.embed_tokens_per_day / 200),
    embed_tokens: quota.planLimits.embed_tokens_per_day,
    extraction_calls: quota.planLimits.extraction_calls_per_day,
    gen_tokens: Math.max(0, quota.planLimits.included_gen_tokens ?? 0),
    storage_bytes: Math.floor(Math.max(0, quota.planLimits.included_storage_gb ?? 0) * 1_000_000_000),
  };
  const estimatedCostInr = estimateRequestCostInr(
    {
      writesDelta: deltas.writesDelta,
      readsDelta: deltas.readsDelta,
      embedTokensDelta: deltas.embedTokensDelta,
      extractionCallsDelta: deltas.extractionCallsDelta,
    },
    env,
  );
  const internalCredits = computeInternalCredits({
    writes: deltas.writesDelta,
    reads: deltas.readsDelta,
    embed_tokens: deltas.embedTokensDelta,
    extraction_calls: deltas.extractionCallsDelta,
  });
  const { data, error } = await supabase.rpc("reserve_usage_if_within_cap", {
    p_workspace_id: workspaceId,
    p_day: day,
    p_request_id: requestId,
    p_route: meta?.route ?? "unknown",
    p_writes_delta: deltas.writesDelta,
    p_reads_delta: deltas.readsDelta,
    p_embeds_delta: deltas.embedsDelta,
    p_embed_tokens_delta: deltas.embedTokensDelta,
    p_extraction_calls_delta: deltas.extractionCallsDelta,
    p_estimated_cost_inr: estimatedCostInr,
    p_internal_credits_total: internalCredits.total,
    p_writes_cap: caps.writes,
    p_reads_cap: caps.reads,
    p_embeds_cap: caps.embeds,
    p_embed_tokens_cap: caps.embed_tokens,
    p_extraction_calls_cap: caps.extraction_calls,
    p_gen_tokens_cap: caps.gen_tokens,
    p_storage_bytes_cap: caps.storage_bytes,
    p_cost_per_minute_cap_inr: Number(env.WORKSPACE_COST_PER_MINUTE_CAP_INR ?? 0),
  });
  if (error) {
    if ((error.message ?? "").includes("REQUEST_ID_CONFLICT")) {
      throw createHttpError(409, "IDEMPOTENCY_CONFLICT", "request_id reused with different payload or route");
    }
    throw createHttpError(500, "DB_ERROR", `Failed to reserve usage budget: ${error.message}`);
  }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const row = rows[0] as {
    reservation_id?: string | null;
    exceeded?: boolean;
    limit_name?: string | null;
    used_value?: number | null;
    cap_value?: number | null;
  } | undefined;
  if (!row) {
    throw createHttpError(500, "DB_ERROR", "reserve_usage_if_within_cap returned no row");
  }
  if (row.exceeded === true && row.limit_name) {
    if (row.limit_name === "cost_per_minute") {
      return {
        response: jsonResponse(
          {
            error: {
              code: "rate_limited",
              limit: row.limit_name,
              used: Number(row.used_value ?? 0),
              cap: Number(row.cap_value ?? 0),
              message: "Workspace burst spend limit exceeded",
            },
          },
          429,
          { ...(rateHeaders ?? {}), "retry-after": "60" },
        ),
        reservationId: null,
      };
    }
    return {
      response: planLimitExceededResponse(
        row.limit_name,
        Number(row.used_value ?? 0),
        Number(row.cap_value ?? 0),
        rateHeaders,
        jsonResponse,
        env,
      ),
      reservationId: null,
    };
  }
  const reservationId = typeof row.reservation_id === "string" && row.reservation_id.trim().length > 0
    ? row.reservation_id
    : null;
  void (async () => {
    try {
      await supabase.rpc("process_usage_reservation_refunds", { p_limit: 25 });
    } catch {
      /* best effort */
    }
  })();
  if (Math.random() < 0.01) {
    void (async () => {
      try {
        await supabase.rpc("reconcile_usage_aggregates", {
          p_workspace_id: workspaceId,
          p_day: day,
          p_limit: 1,
        });
      } catch {
        /* best effort */
      }
    })();
  }
  return { response: null, reservationId };
}

export async function markUsageReservationCommitted(
  supabase: SupabaseClient,
  reservationId: string,
): Promise<void> {
  try {
    await supabase.rpc("commit_usage_reservation", { p_reservation_id: reservationId });
  } catch {
    /* best effort */
  }
}

export async function markUsageReservationRefundPending(
  supabase: SupabaseClient,
  reservationId: string,
  errorMessage: string,
): Promise<void> {
  try {
    await supabase.rpc("mark_usage_reservation_refund_pending", {
      p_reservation_id: reservationId,
      p_error_message: errorMessage.slice(0, 500),
    });
  } catch {
    /* best effort */
  }
}
