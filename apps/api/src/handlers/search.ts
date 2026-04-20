import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import {
  acquireWorkspaceConcurrencySlot,
  authenticate,
  isTrustedInternal,
  rateLimit,
  releaseWorkspaceConcurrencySlot,
} from "../auth.js";
import { getRouteRateLimitMax } from "../limits.js";
import type { HandlerDeps } from "../router.js";
import { SearchPayloadSchema, parseWithSchema, type SearchPayload } from "../contracts/index.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import type { QuotaResolutionLike } from "./memories.js";
import { enforceIsolation } from "../middleware/isolation.js";

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
  /** Compact fusion / candidate stats for history and clients. */
  retrieval_trace?: Record<string, unknown>;
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
    meta?: { route?: string; requestId?: string },
  ) => Promise<{ response: Response | null; reservationId: string | null }>;
  markUsageReservationCommitted: (
    supabase: SupabaseClient,
    reservationId: string,
  ) => Promise<void>;
  markUsageReservationRefundPending: (
    supabase: SupabaseClient,
    reservationId: string,
    errorMessage: string,
  ) => Promise<void>;
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

function normalizeOwnerType(input: unknown): "user" | "team" | "app" {
  if (input === "team") return "team";
  if (input === "app" || input === "agent") return "app";
  return "user";
}

function resolveHistoryOwner(params: Record<string, unknown>): { ownerId: string; ownerType: "user" | "team" | "app" } {
  const ownerId =
    typeof params.owner_id === "string"
      ? params.owner_id
      : (typeof params.user_id === "string"
        ? params.user_id
        : (typeof params.entity_id === "string" ? params.entity_id : "default"));
  const ownerType = normalizeOwnerType(params.owner_type ?? params.entity_type);
  return { ownerId, ownerType };
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
  handleContextFeedback: (
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
              effective_plan: "launch",
              ...(quota.expiredAt != null && { expired_at: quota.expiredAt }),
            },
            upgrade_url: (env as { PUBLIC_APP_URL?: string }).PUBLIC_APP_URL
              ? `${(env as { PUBLIC_APP_URL: string }).PUBLIC_APP_URL}/billing`
              : undefined,
          },
          402,
        );
      }
      const skipEdgeRl = isTrustedInternal(request, env);
      let rateHeaders: Record<string, string> = {};
      if (!skipEdgeRl) {
        const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "search", auth.keyCreatedAt));
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
        rateHeaders = { ...rate.headers, ...wsRate.headers };
      }

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
      const isolationResolution = enforceIsolation(
        request,
        env,
        {
          userId: parseResult.data.userId,
          user_id: parseResult.data.user_id,
          scope: parseResult.data.scope,
          namespace: parseResult.data.namespace,
          containerTag: parseResult.data.containerTag,
        },
        { scopedContainerTag: auth.scopedContainerTag ?? null },
      );
      rateHeaders = { ...rateHeaders, ...isolationResolution.responseHeaders };
      parseResult.data.user_id = isolationResolution.isolation.ownerId;
      parseResult.data.owner_id = isolationResolution.isolation.ownerId;
      parseResult.data.namespace = isolationResolution.isolation.containerTag;

      const resolvedSearchMode = parseResult.data.search_mode ?? "hybrid";
      const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toLowerCase();
      const enforceDegradedBlocks = stage === "production" || stage === "prod" || stage === "staging";
      if (enforceDegradedBlocks && quota.degradedEntitlements && resolvedSearchMode !== "keyword") {
        return jsonResponse(
          {
            error: {
              code: "ENTITLEMENT_DEGRADED",
              message: "Semantic search is temporarily unavailable while entitlement checks recover.",
            },
          },
          503,
          rateHeaders,
        );
      }

      const searchMode = resolvedSearchMode;
      const embedsDelta = searchMode === "keyword" ? 0 : 1;
      const embedTokensDelta = d.estimateEmbedTokens(parseResult.data.query.length);
      const today = d.todayUtc();
      const concurrency = await acquireWorkspaceConcurrencySlot(auth.workspaceId, env);
      if (!concurrency.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace in-flight concurrency limit exceeded" } },
          429,
          { ...rateHeaders, ...concurrency.headers },
        );
      }
      const concurrencyHeaders = { ...rateHeaders, ...concurrency.headers };
      try {
      const reserveResult = await d.reserveQuotaAndMaybeRespond(
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
        concurrencyHeaders,
        env,
        jsonResponse,
        { route: "/v1/search", requestId },
      );
      if (reserveResult.response) {
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
        return reserveResult.response;
      }
      const reservationId = reserveResult.reservationId;

      let outcome: SearchOutcome;
      try {
        outcome = await d.performSearch(auth, parseResult.data, env, supabase);
      } catch (err) {
        if (reservationId) {
          await d.markUsageReservationRefundPending(
            supabase,
            reservationId,
            err instanceof Error ? err.message : String(err),
          );
        }
        throw err;
      }

      const saveHistory = request.headers.get("x-save-history")?.toLowerCase() === "true";
      if (saveHistory && auth.workspaceId) {
        void supabase
          .from("search_query_history")
          .insert({
            workspace_id: auth.workspaceId,
            query: parseResult.data.query,
            params: {
              user_id: parseResult.data.user_id,
              owner_id: parseResult.data.owner_id,
              owner_type: parseResult.data.owner_type,
              namespace: parseResult.data.namespace,
              top_k: parseResult.data.top_k,
              page: parseResult.data.page,
              page_size: parseResult.data.page_size,
              filters: parseResult.data.filters,
              explain: parseResult.data.explain,
              search_mode: parseResult.data.search_mode,
              min_score: parseResult.data.min_score,
              retrieval_profile: parseResult.data.retrieval_profile,
            },
            results_snapshot: {
              results: outcome.results,
              total: outcome.total,
              page: outcome.page,
              has_more: outcome.has_more,
            },
            retrieval_trace: outcome.retrieval_trace ?? null,
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
      void d.emitProductEvent(
        supabase,
        "search_executed",
        {
          workspaceId: auth.workspaceId,
          requestId,
          route: "/v1/search",
          method: "POST",
          status: 200,
          effectivePlan: d.effectivePlan(auth.plan, auth.planStatus),
          planStatus: auth.planStatus,
        },
        {
          result_count: outcome.total,
          zero_results: outcome.total === 0,
          page: outcome.page,
          page_size: outcome.page_size,
          has_more: outcome.has_more,
        },
      );
      if (reservationId) {
        await d.markUsageReservationCommitted(supabase, reservationId);
      }
      return jsonResponse(
        {
          results: outcome.results,
          page: outcome.page,
          page_size: outcome.page_size,
          total: outcome.total,
          has_more: outcome.has_more,
          ...(outcome.retrieval_trace ? { retrieval_trace: outcome.retrieval_trace } : {}),
        },
        200,
        concurrencyHeaders,
      );
      } finally {
        await releaseWorkspaceConcurrencySlot(auth.workspaceId, concurrency.leaseToken, env);
      }
    },

    async handleListSearchHistory(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as SearchHandlerDeps;
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
      let historyKeyHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
        const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "search", auth.keyCreatedAt));
        if (!rate.allowed) {
          return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
        }
        historyKeyHeaders = rate.headers;
      }
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 100);
      const { data, error } = await supabase
        .from("search_query_history")
        .select("id, query, params, created_at, retrieval_trace")
        .eq("workspace_id", auth.workspaceId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) {
        return jsonResponse({ error: { code: "DB_ERROR", message: error.message } }, 500, historyKeyHeaders);
      }
      return jsonResponse({ history: data ?? [] }, 200, historyKeyHeaders);
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- requestId reserved for future logging
    async handleReplaySearch(request, env, supabase, auditCtx, requestId = "", deps?) {
      void requestId;
      const d = (deps ?? defaultDeps) as SearchHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      let replayKeyHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
        const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "search", auth.keyCreatedAt));
        if (!rate.allowed) {
          return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
        }
        replayKeyHeaders = rate.headers;
      }
      let body: { query_id?: string };
      try {
        body = (await request.json()) as { query_id?: string };
      } catch {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, 400, replayKeyHeaders);
      }
      const queryId = body.query_id;
      if (!queryId || !UUID_RE.test(queryId)) {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "query_id (UUID) is required" } }, 400, replayKeyHeaders);
      }
      const { data: row, error } = await supabase
        .from("search_query_history")
        .select("id, query, params, results_snapshot, workspace_id")
        .eq("id", queryId)
        .maybeSingle();
      if (error || !row || row.workspace_id !== auth.workspaceId) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "Query not found" } }, 404, replayKeyHeaders);
      }
      const params = (row.params ?? {}) as Record<string, unknown>;
      const replaySearchMode = typeof params.search_mode === "string" &&
        ["hybrid", "vector", "keyword"].includes(params.search_mode)
        ? (params.search_mode as "hybrid" | "vector" | "keyword")
        : undefined;
      const replayMinScore = typeof params.min_score === "number" ? params.min_score : undefined;
      const replayProfile =
        typeof params.retrieval_profile === "string" &&
        ["balanced", "recall", "precision"].includes(params.retrieval_profile)
          ? (params.retrieval_profile as SearchPayload["retrieval_profile"])
          : undefined;
      const { ownerId, ownerType } = resolveHistoryOwner(params);
      const payload: SearchPayload = {
        user_id: ownerId,
        owner_id: ownerId,
        owner_type: ownerType,
        query: String(row.query ?? ""),
        namespace: typeof params.namespace === "string" ? params.namespace : "default",
        top_k: typeof params.top_k === "number" ? params.top_k : undefined,
        page: typeof params.page === "number" ? params.page : 1,
        page_size: typeof params.page_size === "number" ? params.page_size : undefined,
        filters: params.filters as SearchPayload["filters"],
        explain: params.explain === true,
        search_mode: replaySearchMode,
        min_score: replayMinScore,
        retrieval_profile: replayProfile,
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
              effective_plan: "launch",
            },
            upgrade_url: (env as { PUBLIC_APP_URL?: string }).PUBLIC_APP_URL
              ? `${(env as { PUBLIC_APP_URL: string }).PUBLIC_APP_URL}/billing`
              : undefined,
          },
          402,
        );
      }
      let rateHeadersReplay = { ...replayKeyHeaders };
      if (!isTrustedInternal(request, env)) {
        const wsRpmReplay = quotaReplay.planLimits.workspace_rpm ?? 120;
        const wsRateReplay = await d.rateLimitWorkspace(auth.workspaceId, wsRpmReplay, env);
        if (!wsRateReplay.allowed) {
          return jsonResponse(
            { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
            429,
            { ...replayKeyHeaders, ...wsRateReplay.headers },
          );
        }
        rateHeadersReplay = { ...replayKeyHeaders, ...wsRateReplay.headers };
      }
      const todayReplay = d.todayUtc();
      const concurrency = await acquireWorkspaceConcurrencySlot(auth.workspaceId, env);
      if (!concurrency.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace in-flight concurrency limit exceeded" } },
          429,
          { ...rateHeadersReplay, ...concurrency.headers },
        );
      }
      const replayHeaders = { ...rateHeadersReplay, ...concurrency.headers };
      try {
      const reserveReplay = await d.reserveQuotaAndMaybeRespond(
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
        replayHeaders,
        env,
        jsonResponse,
        { route: "/v1/search/replay", requestId },
      );
      if (reserveReplay.response) return reserveReplay.response;
      const replayReservationId = reserveReplay.reservationId;
      let current: SearchOutcome;
      try {
        current = await d.performSearch(auth, payload, env, supabase);
      } catch (err) {
        if (replayReservationId) {
          await d.markUsageReservationRefundPending(
            supabase,
            replayReservationId,
            err instanceof Error ? err.message : String(err),
          );
        }
        throw err;
      }
      if (replayReservationId) {
        await d.markUsageReservationCommitted(supabase, replayReservationId);
      }
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
        replayHeaders,
      );
      } finally {
        await releaseWorkspaceConcurrencySlot(auth.workspaceId, concurrency.leaseToken, env);
      }
    },

    async handleContextFeedback(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as SearchHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      let feedbackKeyHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
        const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "search", auth.keyCreatedAt));
        if (!rate.allowed) {
          return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
        }
        feedbackKeyHeaders = rate.headers;
      }
      const bodyResult = await d.safeParseJson<{
        trace_id?: string;
        query_id?: string;
        chunk_ids_used?: string[];
        chunk_ids_unused?: string[];
        eval_set_id?: string;
      }>(request);
      if (!bodyResult.ok) {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: bodyResult.error } }, 400, feedbackKeyHeaders);
      }
      const traceId = typeof bodyResult.data.trace_id === "string" ? bodyResult.data.trace_id.trim() : "";
      if (!traceId) {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "trace_id is required" } }, 400, feedbackKeyHeaders);
      }
      const used = Array.isArray(bodyResult.data.chunk_ids_used)
        ? bodyResult.data.chunk_ids_used.filter((id) => typeof id === "string" && id.length > 0).slice(0, 200)
        : [];
      const unused = Array.isArray(bodyResult.data.chunk_ids_unused)
        ? bodyResult.data.chunk_ids_unused.filter((id) => typeof id === "string" && id.length > 0).slice(0, 200)
        : [];
      const evalSetId =
        typeof bodyResult.data.eval_set_id === "string" && bodyResult.data.eval_set_id.trim()
          ? bodyResult.data.eval_set_id.trim()
          : undefined;
      await d.emitProductEvent(
        supabase,
        "context_feedback",
        {
          workspaceId: auth.workspaceId,
          requestId,
          route: "/v1/context/feedback",
          method: "POST",
          status: 202,
          effectivePlan: d.effectivePlan(auth.plan, auth.planStatus),
          planStatus: auth.planStatus,
        },
        {
          trace_id: traceId,
          query_id: typeof bodyResult.data.query_id === "string" ? bodyResult.data.query_id : undefined,
          eval_set_id: evalSetId,
          chunk_ids_used: used,
          chunk_ids_unused: unused,
          used_count: used.length,
          unused_count: unused.length,
        },
      );
      return jsonResponse({ accepted: true }, 202, feedbackKeyHeaders);
    },
  };
}
