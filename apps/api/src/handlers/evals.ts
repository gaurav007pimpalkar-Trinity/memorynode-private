import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import {
  acquireWorkspaceConcurrencySlot,
  authenticate,
  rateLimit,
  releaseWorkspaceConcurrencySlot,
} from "../auth.js";
import { getRouteRateLimitMax } from "../limits.js";
import type { HandlerDeps } from "../router.js";
import {
  EvalItemCreateSchema,
  EvalRunSchema,
  EvalSetCreateSchema,
  parseWithSchema,
  type SearchPayload,
} from "../contracts/index.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import type { QuotaResolutionLike } from "./memories.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface EvalSetRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface EvalItemRow {
  id: string;
  eval_set_id: string;
  query: string;
  expected_memory_ids: string[];
  created_at: string;
}

interface EvalRunItemResult {
  eval_item_id: string;
  query: string;
  expected_memory_ids: string[];
  matched_expected_memory_ids: string[];
  precision_at_k: number;
  recall: number;
}

interface SearchOutcome {
  results: Array<{ memory_id: string }>;
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface EvalHandlerDeps extends HandlerDeps {
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
}

async function assertEvalSetOwnedByWorkspace(
  supabase: SupabaseClient,
  evalSetId: string,
  workspaceId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("eval_sets")
    .select("id")
    .eq("id", evalSetId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

export function createEvalHandlers(
  requestDeps: EvalHandlerDeps,
  defaultDeps: EvalHandlerDeps,
): {
  handleCreateEvalSet: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleListEvalSets: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDeleteEvalSet: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    evalSetId: string,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleCreateEvalItem: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleListEvalItems: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    url: URL,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDeleteEvalItem: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    evalItemId: string,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleRunEvalSet: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  async function authAndRate(
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    d: EvalHandlerDeps,
  ): Promise<
    | { ok: true; auth: AuthContext; headers: Record<string, string>; quota: QuotaResolutionLike }
    | { ok: false; response: Response }
  > {
    const auth = await authenticate(request, env, supabase, auditCtx);
    requireWorkspaceId(auth.workspaceId);
    const quota = await d.resolveQuotaForWorkspace(auth, supabase);
    if (quota.blocked) {
      return {
        ok: false,
        response: d.jsonResponse(
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
        ),
      };
    }
    const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "search", auth.keyCreatedAt));
    if (!rate.allowed) {
      return { ok: false, response: d.jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers) };
    }
    const wsRpm = quota.planLimits.workspace_rpm ?? 120;
    const wsRate = await d.rateLimitWorkspace(auth.workspaceId, wsRpm, env);
    if (!wsRate.allowed) {
      return {
        ok: false,
        response: d.jsonResponse(
          { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
          429,
          { ...rate.headers, ...wsRate.headers },
        ),
      };
    }
    return { ok: true, auth, headers: { ...rate.headers, ...wsRate.headers }, quota };
  }

  return {
    async handleCreateEvalSet(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
      const gate = await authAndRate(request, env, supabase, auditCtx, d);
      if (!gate.ok) return gate.response;
      const parseResult = await parseWithSchema(EvalSetCreateSchema, request);
      if (!parseResult.ok) {
        return d.jsonResponse({ error: { code: "BAD_REQUEST", message: parseResult.error } }, 400, gate.headers);
      }
      const { data, error } = await supabase
        .from("eval_sets")
        .insert({
          workspace_id: gate.auth.workspaceId,
          name: parseResult.data.name,
        })
        .select("id, name, created_at, updated_at")
        .single();
      if (error || !data) {
        return d.jsonResponse({ error: { code: "DB_ERROR", message: error?.message ?? "Failed to create eval set" } }, 500, gate.headers);
      }
      return d.jsonResponse({ eval_set: data as EvalSetRow }, 201, gate.headers);
    },

    async handleListEvalSets(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
      const gate = await authAndRate(request, env, supabase, auditCtx, d);
      if (!gate.ok) return gate.response;
      const { data, error } = await supabase
        .from("eval_sets")
        .select("id, name, created_at, updated_at")
        .eq("workspace_id", gate.auth.workspaceId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) {
        return d.jsonResponse({ error: { code: "DB_ERROR", message: error.message } }, 500, gate.headers);
      }
      return d.jsonResponse({ eval_sets: (data ?? []) as EvalSetRow[] }, 200, gate.headers);
    },

    async handleDeleteEvalSet(request, env, supabase, evalSetId, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
      const gate = await authAndRate(request, env, supabase, auditCtx, d);
      if (!gate.ok) return gate.response;
      const exists = await assertEvalSetOwnedByWorkspace(supabase, evalSetId, gate.auth.workspaceId);
      if (!exists) return d.jsonResponse({ error: { code: "NOT_FOUND", message: "Eval set not found" } }, 404, gate.headers);
      const { error } = await supabase
        .from("eval_sets")
        .delete()
        .eq("id", evalSetId)
        .eq("workspace_id", gate.auth.workspaceId);
      if (error) return d.jsonResponse({ error: { code: "DB_ERROR", message: error.message } }, 500, gate.headers);
      return d.jsonResponse({ deleted: true, id: evalSetId }, 200, gate.headers);
    },

    async handleCreateEvalItem(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
      const gate = await authAndRate(request, env, supabase, auditCtx, d);
      if (!gate.ok) return gate.response;
      const parseResult = await parseWithSchema(EvalItemCreateSchema, request);
      if (!parseResult.ok) {
        return d.jsonResponse({ error: { code: "BAD_REQUEST", message: parseResult.error } }, 400, gate.headers);
      }
      const owned = await assertEvalSetOwnedByWorkspace(supabase, parseResult.data.eval_set_id, gate.auth.workspaceId);
      if (!owned) return d.jsonResponse({ error: { code: "NOT_FOUND", message: "Eval set not found" } }, 404, gate.headers);
      const { data, error } = await supabase
        .from("eval_items")
        .insert({
          eval_set_id: parseResult.data.eval_set_id,
          query: parseResult.data.query,
          expected_memory_ids: parseResult.data.expected_memory_ids,
        })
        .select("id, eval_set_id, query, expected_memory_ids, created_at")
        .single();
      if (error || !data) {
        return d.jsonResponse({ error: { code: "DB_ERROR", message: error?.message ?? "Failed to create eval item" } }, 500, gate.headers);
      }
      return d.jsonResponse({ eval_item: data as EvalItemRow }, 201, gate.headers);
    },

    async handleListEvalItems(request, env, supabase, url, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
      const gate = await authAndRate(request, env, supabase, auditCtx, d);
      if (!gate.ok) return gate.response;
      const evalSetId = url.searchParams.get("eval_set_id")?.trim() ?? "";
      if (!evalSetId || !UUID_RE.test(evalSetId)) {
        return d.jsonResponse({ error: { code: "BAD_REQUEST", message: "eval_set_id (UUID) is required" } }, 400, gate.headers);
      }
      const owned = await assertEvalSetOwnedByWorkspace(supabase, evalSetId, gate.auth.workspaceId);
      if (!owned) return d.jsonResponse({ error: { code: "NOT_FOUND", message: "Eval set not found" } }, 404, gate.headers);
      const { data, error } = await supabase
        .from("eval_items")
        .select("id, eval_set_id, query, expected_memory_ids, created_at")
        .eq("eval_set_id", evalSetId)
        .order("created_at", { ascending: false });
      if (error) return d.jsonResponse({ error: { code: "DB_ERROR", message: error.message } }, 500, gate.headers);
      return d.jsonResponse({ eval_items: (data ?? []) as EvalItemRow[] }, 200, gate.headers);
    },

    async handleDeleteEvalItem(request, env, supabase, evalItemId, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
      const gate = await authAndRate(request, env, supabase, auditCtx, d);
      if (!gate.ok) return gate.response;
      const { data: item, error: itemError } = await supabase
        .from("eval_items")
        .select("id, eval_set_id")
        .eq("id", evalItemId)
        .maybeSingle();
      if (itemError || !item) return d.jsonResponse({ error: { code: "NOT_FOUND", message: "Eval item not found" } }, 404, gate.headers);
      const owned = await assertEvalSetOwnedByWorkspace(supabase, String(item.eval_set_id), gate.auth.workspaceId);
      if (!owned) return d.jsonResponse({ error: { code: "NOT_FOUND", message: "Eval item not found" } }, 404, gate.headers);
      const { error } = await supabase.from("eval_items").delete().eq("id", evalItemId);
      if (error) return d.jsonResponse({ error: { code: "DB_ERROR", message: error.message } }, 500, gate.headers);
      return d.jsonResponse({ deleted: true, id: evalItemId }, 200, gate.headers);
    },

    async handleRunEvalSet(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
      const gate = await authAndRate(request, env, supabase, auditCtx, d);
      if (!gate.ok) return gate.response;
      const parseResult = await parseWithSchema(EvalRunSchema, request);
      if (!parseResult.ok) {
        return d.jsonResponse({ error: { code: "BAD_REQUEST", message: parseResult.error } }, 400, gate.headers);
      }
      const owned = await assertEvalSetOwnedByWorkspace(supabase, parseResult.data.eval_set_id, gate.auth.workspaceId);
      if (!owned) return d.jsonResponse({ error: { code: "NOT_FOUND", message: "Eval set not found" } }, 404, gate.headers);
      const { data: items, error: itemsError } = await supabase
        .from("eval_items")
        .select("id, eval_set_id, query, expected_memory_ids, created_at")
        .eq("eval_set_id", parseResult.data.eval_set_id)
        .order("created_at", { ascending: true });
      if (itemsError) return d.jsonResponse({ error: { code: "DB_ERROR", message: itemsError.message } }, 500, gate.headers);
      const evalItems = (items ?? []) as EvalItemRow[];
      if (evalItems.length === 0) {
        return d.jsonResponse({
          eval_set_id: parseResult.data.eval_set_id,
          item_count: 0,
          avg_precision_at_k: 0,
          avg_recall: 0,
          items: [],
        }, 200, gate.headers);
      }
      const searchMode = parseResult.data.search_mode ?? "hybrid";
      const embedsDelta = searchMode === "keyword" ? 0 : evalItems.length;
      const embedTokensDelta = searchMode === "keyword"
        ? 0
        : evalItems.reduce((sum, item) => sum + d.estimateEmbedTokens(item.query.length), 0);
      const today = d.todayUtc();
      const concurrency = await acquireWorkspaceConcurrencySlot(gate.auth.workspaceId, env);
      if (!concurrency.allowed) {
        return d.jsonResponse(
          { error: { code: "rate_limited", message: "Workspace in-flight concurrency limit exceeded" } },
          429,
          { ...gate.headers, ...concurrency.headers },
        );
      }
      const combinedHeaders = { ...gate.headers, ...concurrency.headers };
      try {
        const reserve = await d.reserveQuotaAndMaybeRespond(
          gate.quota,
          supabase,
          gate.auth.workspaceId,
          today,
          {
            writesDelta: 0,
            readsDelta: evalItems.length,
            embedsDelta,
            embedTokensDelta,
            extractionCallsDelta: 0,
          },
          combinedHeaders,
          env,
          d.jsonResponse,
          { route: "/v1/evals/run", requestId },
        );
        if (reserve.response) return reserve.response;
        const reservationId = reserve.reservationId;
        const topK = parseResult.data.top_k ?? 5;
        let runResults: EvalRunItemResult[];
        try {
          runResults = [];
          for (const item of evalItems) {
            const outcome = await d.performSearch(
              gate.auth,
              {
                user_id: parseResult.data.user_id,
                owner_id: parseResult.data.owner_id,
                owner_type: parseResult.data.owner_type,
                query: item.query,
                namespace: parseResult.data.namespace ?? "default",
                top_k: topK,
                page: 1,
                page_size: topK,
                search_mode: searchMode,
                min_score: parseResult.data.min_score,
              },
              env,
              supabase,
            );
            const expected = new Set((item.expected_memory_ids ?? []).map(String));
            const matched = Array.from(new Set(outcome.results.map((r) => String(r.memory_id)).filter((id) => expected.has(id))));
            const precision = matched.length / topK;
            const recall = expected.size > 0 ? matched.length / expected.size : 1;
            runResults.push({
              eval_item_id: item.id,
              query: item.query,
              expected_memory_ids: Array.from(expected),
              matched_expected_memory_ids: matched,
              precision_at_k: Number(precision.toFixed(6)),
              recall: Number(recall.toFixed(6)),
            });
          }
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
        if (reservationId) await d.markUsageReservationCommitted(supabase, reservationId);
        const avgPrecision = runResults.reduce((s, r) => s + r.precision_at_k, 0) / runResults.length;
        const avgRecall = runResults.reduce((s, r) => s + r.recall, 0) / runResults.length;
        return d.jsonResponse(
          {
            eval_set_id: parseResult.data.eval_set_id,
            item_count: runResults.length,
            avg_precision_at_k: Number(avgPrecision.toFixed(6)),
            avg_recall: Number(avgRecall.toFixed(6)),
            items: runResults,
          },
          200,
          combinedHeaders,
        );
      } finally {
        await releaseWorkspaceConcurrencySlot(gate.auth.workspaceId, concurrency.leaseToken, env);
      }
    },
  };
}
