import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import { SearchPayloadSchema, parseWithSchema, type SearchPayload } from "../contracts/index.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import type { QuotaResolutionLike } from "./memories.js";

export type { SearchPayload } from "../contracts/index.js";

export interface SearchOutcome {
  results: Array<{
    chunk_id: string;
    memory_id: string;
    chunk_index: number;
    text: string;
    score: number;
  }>;
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface SearchHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  resolveQuotaForWorkspace: (auth: AuthContext, supabase: SupabaseClient) => Promise<QuotaResolutionLike>;
  rateLimitWorkspace: (workspaceId: string, workspaceRpm: number, env: Env) => Promise<{ allowed: boolean; headers: Record<string, string> }>;
  reserveQuotaAndMaybeRespond: (
    quota: QuotaResolutionLike,
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
  ) => Promise<Response | null>;
  todayUtc: () => string;
  estimateEmbedTokens: (textLength: number) => number;
  performSearch: (
    auth: AuthContext,
    payload: SearchPayload,
    env: Env,
    supabase: SupabaseClient,
  ) => Promise<SearchOutcome>;
  emitProductEvent: (
    supabase: SupabaseClient,
    eventName: string,
    ctx: {
      workspaceId?: string;
      requestId?: string;
      route?: string;
      method?: string;
      status?: number;
      effectivePlan?: AuthContext["plan"];
      planStatus?: AuthContext["planStatus"];
    },
    props?: Record<string, unknown>,
    ensureUnique?: boolean,
  ) => Promise<void>;
  effectivePlan: (plan: AuthContext["plan"], status?: AuthContext["planStatus"]) => AuthContext["plan"];
}

export function createSearchHandlers(
  requestDeps: SearchHandlerDeps,
  defaultDeps: SearchHandlerDeps,
): {
  handleSearch: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleListSearchHistory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleReplaySearch: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return {
    async handleSearch(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as SearchHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quota.blocked) {
        return jsonResponse(
          {
            error: {
              code: quota.errorCode ?? "ENTITLEMENT_EXPIRED",
              message: quota.message ?? "Active entitlement expired. Renew to continue quota-consuming API calls.",
              upgrade_required: true,
              effective_plan: "free",
              ...(quota.expiredAt != null && { expired_at: quota.expiredAt }),
            },
            upgrade_url: (env as { PUBLIC_APP_URL?: string }).PUBLIC_APP_URL
              ? `${(env as { PUBLIC_APP_URL: string }).PUBLIC_APP_URL}/billing`
              : undefined,
          },
          402,
        );
      }
      const rate = await rateLimit(auth.keyHash, env, auth);
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

      const parseResult = await parseWithSchema(SearchPayloadSchema, request);
      if (!parseResult.ok) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: parseResult.error,
              ...(parseResult.details ? { details: parseResult.details } : {}),
            },
          },
          400,
          rateHeaders,
        );
      }

      const searchMode = parseResult.data.search_mode ?? "hybrid";
      const embedsDelta = searchMode === "keyword" ? 0 : 1;
      const embedTokensDelta = d.estimateEmbedTokens(parseResult.data.query.length);
      const today = d.todayUtc();
      const capResponse = await d.reserveQuotaAndMaybeRespond(
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
        rateHeaders,
        env,
        jsonResponse,
      );
      if (capResponse) {
        void d.emitProductEvent(
          supabase,
          "cap_exceeded",
          {
            workspaceId: auth.workspaceId,
            requestId,
            route: "/v1/search",
            method: "POST",
            status: 402,
            effectivePlan: d.effectivePlan(auth.plan, auth.planStatus),
            planStatus: auth.planStatus,
          },
          {},
        );
        return capResponse;
      }

      const outcome = await d.performSearch(auth, parseResult.data, env, supabase);

      const saveHistory = request.headers.get("x-save-history")?.toLowerCase() === "true";
      if (saveHistory && auth.workspaceId) {
        void supabase
          .from("search_query_history")
          .insert({
            workspace_id: auth.workspaceId,
            query: parseResult.data.query,
            params: {
              user_id: parseResult.data.user_id,
              namespace: parseResult.data.namespace,
              top_k: parseResult.data.top_k,
              page: parseResult.data.page,
              page_size: parseResult.data.page_size,
              filters: parseResult.data.filters,
              explain: parseResult.data.explain,
              search_mode: parseResult.data.search_mode,
              min_score: parseResult.data.min_score,
            },
            results_snapshot: {
              results: outcome.results,
              total: outcome.total,
              page: outcome.page,
              has_more: outcome.has_more,
            },
          })
          .then(() => {});
      }

      void d.emitProductEvent(
        supabase,
        "first_search_success",
        {
          workspaceId: auth.workspaceId,
          requestId,
          route: "/v1/search",
          method: "POST",
          status: 200,
          effectivePlan: d.effectivePlan(auth.plan, auth.planStatus),
          planStatus: auth.planStatus,
        },
        { body_bytes: Number(request.headers.get("content-length") ?? "0") || undefined },
        true,
      );
      return jsonResponse(
        {
          results: outcome.results,
          page: outcome.page,
          page_size: outcome.page_size,
          total: outcome.total,
          has_more: outcome.has_more,
        },
        200,
        rateHeaders,
      );
    },

    async handleListSearchHistory(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as SearchHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 100);
      const { data, error } = await supabase
        .from("search_query_history")
        .select("id, query, params, created_at")
        .eq("workspace_id", auth.workspaceId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) {
        return jsonResponse({ error: { code: "DB_ERROR", message: error.message } }, 500, rate.headers);
      }
      return jsonResponse({ history: data ?? [] }, 200, rate.headers);
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- requestId reserved for future logging
    async handleReplaySearch(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as SearchHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      let body: { query_id?: string };
      try {
        body = (await request.json()) as { query_id?: string };
      } catch {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, 400, rate.headers);
      }
      const queryId = body.query_id;
      if (!queryId || !UUID_RE.test(queryId)) {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "query_id (UUID) is required" } }, 400, rate.headers);
      }
      const { data: row, error } = await supabase
        .from("search_query_history")
        .select("id, query, params, results_snapshot, workspace_id")
        .eq("id", queryId)
        .maybeSingle();
      if (error || !row || row.workspace_id !== auth.workspaceId) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "Query not found" } }, 404, rate.headers);
      }
      const params = (row.params ?? {}) as Record<string, unknown>;
      const replaySearchMode = typeof params.search_mode === "string" &&
        ["hybrid", "vector", "keyword"].includes(params.search_mode)
        ? (params.search_mode as "hybrid" | "vector" | "keyword")
        : undefined;
      const replayMinScore = typeof params.min_score === "number" ? params.min_score : undefined;
      const payload: SearchPayload = {
        user_id: typeof params.user_id === "string" ? params.user_id : "default",
        query: String(row.query ?? ""),
        namespace: typeof params.namespace === "string" ? params.namespace : undefined,
        top_k: typeof params.top_k === "number" ? params.top_k : undefined,
        page: typeof params.page === "number" ? params.page : 1,
        page_size: typeof params.page_size === "number" ? params.page_size : undefined,
        filters: params.filters as SearchPayload["filters"],
        explain: params.explain === true,
        search_mode: replaySearchMode,
        min_score: replayMinScore,
      };
      const replayEmbedsDelta = (replaySearchMode ?? "hybrid") === "keyword" ? 0 : 1;
      const replayEmbedTokensDelta = d.estimateEmbedTokens(String(row.query ?? "").length);
      const quotaReplay = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quotaReplay.blocked) {
        return jsonResponse(
          {
            error: {
              code: "ENTITLEMENT_EXPIRED",
              message: "Active entitlement expired. Renew to continue quota-consuming API calls.",
              upgrade_required: true,
              effective_plan: "free",
            },
            upgrade_url: (env as { PUBLIC_APP_URL?: string }).PUBLIC_APP_URL
              ? `${(env as { PUBLIC_APP_URL: string }).PUBLIC_APP_URL}/billing`
              : undefined,
          },
          402,
        );
      }
      const wsRpmReplay = quotaReplay.planLimits.workspace_rpm ?? 120;
      const wsRateReplay = await d.rateLimitWorkspace(auth.workspaceId, wsRpmReplay, env);
      if (!wsRateReplay.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
          429,
          { ...rate.headers, ...wsRateReplay.headers },
        );
      }
      const rateHeadersReplay = { ...rate.headers, ...wsRateReplay.headers };
      const todayReplay = d.todayUtc();
      const capResponseReplay = await d.reserveQuotaAndMaybeRespond(
        quotaReplay,
        supabase,
        auth.workspaceId,
        todayReplay,
        {
          writesDelta: 0,
          readsDelta: 1,
          embedsDelta: replayEmbedsDelta,
          embedTokensDelta: replayEmbedTokensDelta,
          extractionCallsDelta: 0,
        },
        rateHeadersReplay,
        env,
        jsonResponse,
      );
      if (capResponseReplay) return capResponseReplay;
      const current = await d.performSearch(auth, payload, env, supabase);
      return jsonResponse(
        {
          query_id: queryId,
          previous: row.results_snapshot ?? null,
          current: {
            results: current.results,
            total: current.total,
            page: current.page,
            page_size: current.page_size,
            has_more: current.has_more,
          },
        },
        200,
        rateHeadersReplay,
      );
    },
  };
}
