/**
 * Hosted MCP hot paths: call search/list services in-process instead of REST (internal JSON fetch).
 * Uses dynamic import of ../workerApp.js so mcpHosted stays free of circular imports with workerApp.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "../auth.js";
import { acquireWorkspaceConcurrencySlot, releaseWorkspaceConcurrencySlot } from "../auth.js";
import type { SearchPayload } from "../contracts/search.js";
import type { Env } from "../env.js";
import type { MemoryListParams } from "../handlers/memories.js";
import { isApiError } from "../http.js";
import {
  markUsageReservationCommitted,
  markUsageReservationRefundPending,
  reserveQuotaAndMaybeRespond,
} from "../usage/quotaReservation.js";
import { resolveQuotaForWorkspace } from "../usage/quotaResolution.js";

export type HostedDirectJsonResult = { ok: boolean; status: number; data: unknown };

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function estimateEmbedTokens(textLength: number): number {
  return Math.ceil(Math.max(0, textLength) / 4);
}

function jsonResponseShim(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function responseToInternalJsonShape(res: Response): Promise<HostedDirectJsonResult> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

function mapThrownToJson(e: unknown): HostedDirectJsonResult {
  if (isApiError(e) && typeof e.status === "number") {
    return {
      ok: false,
      status: e.status,
      data: { error: { code: e.code, message: e.message } },
    };
  }
  const msg = e instanceof Error ? e.message : "Request failed";
  return {
    ok: false,
    status: 500,
    data: { error: { code: "INTERNAL", message: msg } },
  };
}

export async function hostedDirectSearch(args: {
  auth: AuthContext;
  env: Env;
  supabase: SupabaseClient;
  requestId: string;
  user_id: string;
  namespace: string;
  query: string;
  top_k: number;
}): Promise<HostedDirectJsonResult> {
  const { auth, env, supabase, requestId, user_id, namespace, query, top_k } = args;

  const quota = await resolveQuotaForWorkspace(auth, supabase);
  if (quota.blocked) {
    return {
      ok: false,
      status: 402,
      data: {
        error: {
          code: quota.errorCode ?? "ENTITLEMENT_EXPIRED",
          message: quota.message ?? "Active entitlement expired.",
          upgrade_required: true,
          effective_plan: "launch",
          ...(quota.expiredAt != null && { expired_at: quota.expiredAt }),
        },
        upgrade_url: env.PUBLIC_APP_URL ? `${env.PUBLIC_APP_URL}/billing` : undefined,
      },
    };
  }

  const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toLowerCase();
  const enforceDegradedBlocks = stage === "production" || stage === "prod" || stage === "staging";
  if (enforceDegradedBlocks && quota.degradedEntitlements) {
    return {
      ok: false,
      status: 503,
      data: {
        error: {
          code: "ENTITLEMENT_DEGRADED",
          message: "Semantic search is temporarily unavailable while entitlement checks recover.",
        },
      },
    };
  }

  const concurrency = await acquireWorkspaceConcurrencySlot(auth.workspaceId, env);
  if (!concurrency.allowed) {
    return {
      ok: false,
      status: 429,
      data: { error: { code: "rate_limited", message: "Workspace in-flight concurrency limit exceeded" } },
    };
  }

  try {
    const embedsDelta = 1;
    const embedTokensDelta = estimateEmbedTokens(query.length);
    const today = todayUtc();

    const reserveResult = await reserveQuotaAndMaybeRespond(
      quota,
      supabase,
      auth.workspaceId,
      today,
      {
        writesDelta: 0,
        readsDelta: 1,
        embedsDelta,
        embedTokensDelta,
        extractionCallsDelta: 0,
      },
      concurrency.headers,
      env,
      jsonResponseShim,
      { route: "/v1/search", requestId },
    );

    if (reserveResult.response) {
      return await responseToInternalJsonShape(reserveResult.response);
    }

    const reservationId = reserveResult.reservationId;

    const payload: SearchPayload = {
      query,
      user_id,
      owner_id: user_id,
      owner_type: "user",
      namespace,
      top_k,
      page: 1,
      page_size: top_k,
      search_mode: "hybrid",
    };

    try {
      const mod = await import("../workerApp.js");
      let outcome: Awaited<ReturnType<(typeof mod)["performSearch"]>>;
      try {
        outcome = await mod.performSearch(auth, payload, env, supabase);
      } catch (err) {
        if (reservationId) {
          await markUsageReservationRefundPending(
            supabase,
            reservationId,
            err instanceof Error ? err.message : String(err),
          );
        }
        return mapThrownToJson(err);
      }

      if (reservationId) {
        await markUsageReservationCommitted(supabase, reservationId);
      }

      return {
        ok: true,
        status: 200,
        data: {
          results: outcome.results,
          page: outcome.page,
          page_size: outcome.page_size,
          total: outcome.total,
          has_more: outcome.has_more,
          ...(outcome.retrieval_trace ? { retrieval_trace: outcome.retrieval_trace } : {}),
        },
      };
    } catch (err) {
      return mapThrownToJson(err);
    }
  } finally {
    await releaseWorkspaceConcurrencySlot(auth.workspaceId, concurrency.leaseToken, env);
  }
}

export async function hostedDirectListMemories(args: {
  auth: AuthContext;
  env: Env;
  supabase: SupabaseClient;
  requestId: string;
  params: MemoryListParams;
}): Promise<HostedDirectJsonResult> {
  const { auth, env, supabase, requestId, params } = args;

  const quota = await resolveQuotaForWorkspace(auth, supabase);
  if (quota.blocked) {
    return {
      ok: false,
      status: 402,
      data: {
        error: {
          code: quota.errorCode ?? "ENTITLEMENT_REQUIRED",
          message:
            quota.message ??
            "No active paid entitlement found. Start a plan to continue quota-consuming API calls.",
          upgrade_required: true,
          effective_plan: "launch",
        },
        upgrade_url: env.PUBLIC_APP_URL ? `${env.PUBLIC_APP_URL}/billing` : undefined,
      },
    };
  }

  const reserveList = await reserveQuotaAndMaybeRespond(
    quota,
    supabase,
    auth.workspaceId,
    todayUtc(),
    {
      writesDelta: 0,
      readsDelta: 1,
      embedsDelta: 0,
      embedTokensDelta: 0,
      extractionCallsDelta: 0,
    },
    {},
    env,
    jsonResponseShim,
    { route: "/v1/memories", requestId },
  );

  if (reserveList.response) {
    return await responseToInternalJsonShape(reserveList.response);
  }

  const listReservationId = reserveList.reservationId;

  try {
    const mod = await import("../workerApp.js");
    let result: Awaited<ReturnType<(typeof mod)["performListMemories"]>>;
    try {
      result = await mod.performListMemories(auth, params, supabase);
    } catch (err) {
      if (listReservationId) {
        await markUsageReservationRefundPending(
          supabase,
          listReservationId,
          err instanceof Error ? err.message : String(err),
        );
      }
      return mapThrownToJson(err);
    }

    if (listReservationId) {
      await markUsageReservationCommitted(supabase, listReservationId);
    }

    return {
      ok: true,
      status: 200,
      data: {
        results: result.results,
        page: result.page,
        page_size: result.page_size,
        total: result.total,
        has_more: result.has_more,
      },
    };
  } catch (err) {
    return mapThrownToJson(err);
  }
}
