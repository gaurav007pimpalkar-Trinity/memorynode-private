import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Env } from "../env.js";
import { authenticate, rateLimit } from "../auth.js";
import { getRouteRateLimitMax } from "../limits.js";
import type { HandlerDeps } from "../router.js";
import type { SearchHandlerDeps } from "./search.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import { createHttpError } from "../http.js";
import { enforceIsolation } from "../middleware/isolation.js";

export type ContextExplainHandlerDeps = SearchHandlerDeps;

const QuerySchema = z.object({
  userId: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  owner_id: z.string().min(1).optional(),
  owner_type: z.enum(["user", "team", "app", "agent"]).optional(),
  query: z.string().min(1),
  scope: z.string().optional(),
  namespace: z.string().optional(),
  containerTag: z.string().optional(),
  top_k: z.number().int().min(1).max(20).optional(),
  page: z.number().int().min(1).optional(),
  page_size: z.number().int().min(1).max(50).optional(),
  search_mode: z.enum(["hybrid", "vector", "keyword"]).optional(),
  min_score: z.number().min(0).max(1).optional(),
  retrieval_profile: z.enum(["balanced", "recall", "precision"]).optional(),
}).superRefine((value, ctx) => {
  const userId = value.userId?.trim() ?? value.user_id?.trim() ?? "";
  const ownerId = value.owner_id?.trim() ?? "";
  const ids = [userId, ownerId].filter(Boolean);
  const resolved = ids[0] ?? "";
  if (ids.some((id) => id !== resolved)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "user_id and owner_id must match when provided together",
      path: ["owner_id"],
    });
  }
}).transform((value) => {
  const resolvedId = (value.userId?.trim() || value.user_id?.trim() || value.owner_id?.trim() || "shared_app") as string;
  const rawOwnerType = value.owner_type ?? "user";
  const ownerType = rawOwnerType === "agent" ? "app" : rawOwnerType;
  return {
    ...value,
    user_id: resolvedId,
    owner_id: resolvedId,
    owner_type: ownerType,
    namespace: value.containerTag?.trim() || value.namespace?.trim() || value.scope?.trim() || "default",
  };
});

function toNumberOrUndefined(value: string | null): number | undefined {
  if (value == null || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recencyMultiplier(lastTouchedIso: string): number {
  const touched = new Date(lastTouchedIso).getTime();
  if (!Number.isFinite(touched)) return 1;
  const days = Math.max(0, (Date.now() - touched) / (1000 * 60 * 60 * 24));
  return Math.exp((-Math.log(2) * days) / 30);
}

export function createContextExplainHandlers(
  requestDeps: ContextExplainHandlerDeps,
  defaultDeps: ContextExplainHandlerDeps,
): {
  handleContextExplain: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleContextExplain(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as ContextExplainHandlerDeps;
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
      const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "context", auth.keyCreatedAt));
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

      const url = new URL(request.url);
      const parse = QuerySchema.safeParse({
        userId: url.searchParams.get("userId") ?? undefined,
        user_id: url.searchParams.get("user_id") ?? undefined,
        owner_id: (url.searchParams.get("owner_id") ?? url.searchParams.get("entity_id")) ?? undefined,
        owner_type: url.searchParams.get("owner_type") ?? url.searchParams.get("entity_type") ?? undefined,
        query: url.searchParams.get("query"),
        scope: url.searchParams.get("scope") ?? undefined,
        namespace: url.searchParams.get("namespace") ?? undefined,
        containerTag: url.searchParams.get("containerTag") ?? undefined,
        top_k: toNumberOrUndefined(url.searchParams.get("top_k")),
        page: toNumberOrUndefined(url.searchParams.get("page")),
        page_size: toNumberOrUndefined(url.searchParams.get("page_size")),
        search_mode: url.searchParams.get("search_mode") ?? undefined,
        min_score: toNumberOrUndefined(url.searchParams.get("min_score")),
        retrieval_profile: url.searchParams.get("retrieval_profile") ?? undefined,
      });
      if (!parse.success) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: "Invalid query parameters",
              details: parse.error.flatten().fieldErrors,
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
          userId: parse.data.userId,
          user_id: parse.data.user_id,
          scope: parse.data.scope,
          namespace: parse.data.namespace,
          containerTag: parse.data.containerTag,
        },
        { scopedContainerTag: auth.scopedContainerTag ?? null },
      );
      const rateHeadersWithRouting = { ...rateHeaders, ...isolationResolution.responseHeaders };
      const payload = {
        ...parse.data,
        user_id: isolationResolution.isolation.ownerId,
        owner_id: isolationResolution.isolation.ownerId,
        namespace: isolationResolution.isolation.containerTag,
        explain: true,
      };
      const searchMode = payload.search_mode ?? "hybrid";
      const embedsDelta = searchMode === "keyword" ? 0 : 1;
      const embedTokensDelta = d.estimateEmbedTokens(payload.query.length);
      const today = d.todayUtc();
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
        rateHeadersWithRouting,
        env,
        jsonResponse,
        { route: "/v1/context/explain", requestId },
      );
      if (reserveResult.response) return reserveResult.response;
      const reservationId = reserveResult.reservationId;

      let outcome;
      try {
        outcome = await d.performSearch(auth, payload, env, supabase);
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

      const chunkIds = outcome.results.map((r) => r.chunk_id);
      const memoryIds = [...new Set(outcome.results.map((r) => r.memory_id))];
      const [chunkMetaRes, memoryMetaRes] = await Promise.all([
        chunkIds.length > 0
          ? supabase
              .from("memory_chunks")
              .select("id, memory_id, created_at, last_accessed_at")
              .eq("workspace_id", auth.workspaceId)
              .in("id", chunkIds)
          : Promise.resolve({ data: [], error: null }),
        memoryIds.length > 0
          ? supabase
              .from("memories")
              .select("id, text, importance")
              .eq("workspace_id", auth.workspaceId)
              .in("id", memoryIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (chunkMetaRes.error) {
        throw createHttpError(500, "DB_ERROR", chunkMetaRes.error.message ?? "Failed to fetch chunk metadata");
      }
      if (memoryMetaRes.error) {
        throw createHttpError(500, "DB_ERROR", memoryMetaRes.error.message ?? "Failed to fetch memory metadata");
      }

      const chunkMeta = new Map(
        (chunkMetaRes.data ?? []).map((row) => [
          String((row as { id: string }).id),
          row as { id: string; memory_id: string; created_at: string; last_accessed_at?: string | null },
        ]),
      );
      const memoryMeta = new Map(
        (memoryMetaRes.data ?? []).map((row) => [
          String((row as { id: string }).id),
          row as { id: string; text: string; importance?: number | null },
        ]),
      );

      const explained = outcome.results.map((result, idx) => {
        const chunk = chunkMeta.get(result.chunk_id);
        const memory = memoryMeta.get(result.memory_id);
        const touchedAt = chunk?.last_accessed_at ?? chunk?.created_at ?? new Date().toISOString();
        const recency = recencyMultiplier(touchedAt);
        const importance = Math.max(0.01, Number(memory?.importance ?? 1));
        const explain = (result as {
          _explain?: { vector_score?: number; text_score?: number; rrf_score: number; match_sources: string[] };
        })._explain;
        const relevance = Math.max(
          0,
          Number(explain?.vector_score ?? 0),
          Number(explain?.text_score ?? 0),
          Number(explain?.rrf_score ?? 0),
        );
        return {
          rank: idx + 1,
          memory_id: result.memory_id,
          chunk_id: result.chunk_id,
          chunk_index: result.chunk_index,
          text: result.text,
          scores: {
            relevance_score: relevance,
            recency_score: recency,
            importance_score: importance,
            final_score: result.score,
          },
          ordering_explanation:
            `Ranked #${idx + 1} by fused relevance and then adjusted by recency and importance signals.`,
        };
      });

      if (reservationId) {
        await d.markUsageReservationCommitted(supabase, reservationId);
      }

      return jsonResponse(
        {
          query: {
            user_id: payload.user_id,
            owner_id: payload.owner_id,
            owner_type: payload.owner_type,
            namespace: payload.namespace ?? null,
            query: payload.query,
            top_k: payload.top_k ?? null,
            search_mode: searchMode,
            min_score: payload.min_score ?? null,
            retrieval_profile: payload.retrieval_profile ?? null,
          },
          memories_retrieved: memoryIds.map((id) => ({
            memory_id: id,
            text: memoryMeta.get(id)?.text ?? "",
          })),
          chunk_ids_used: chunkIds,
          results: explained,
          total: outcome.total,
          page: outcome.page,
          page_size: outcome.page_size,
          has_more: outcome.has_more,
        },
        200,
        rateHeadersWithRouting,
      );
    },
  };
}
