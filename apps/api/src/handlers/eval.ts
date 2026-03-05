/**
 * Eval handler: CRUD + run retrieval evaluation. Phase 5 retrieval cockpit.
 * Phase 6: Cap items per run (max 100), total delta, atomic RPC before run.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit, rateLimitWorkspace } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import type { SearchOutcome } from "./search.js";
import type { QuotaResolutionLike } from "./memories.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Max eval items per run for cap enforcement. */
export const EVAL_RUN_ITEMS_CAP = 100;

const RunEvalSchema = {
  eval_set_id: (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null),
  user_id: (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null),
  namespace: (v: unknown) => (v === undefined || v === null ? "default" : typeof v === "string" ? v : null),
};

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
  ) => Promise<Response | null>;
  todayUtc: () => string;
  estimateEmbedTokens: (textLength: number) => number;
  performSearch: (
    auth: AuthContext,
    payload: { user_id: string; query: string; namespace?: string; top_k?: number; explain?: boolean },
    env: Env,
    supabase: SupabaseClient,
  ) => Promise<SearchOutcome>;
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
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleAddEvalItem: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    evalSetId: string,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleListEvalSets: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleRunEval: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleCreateEvalSet(request, env, supabase, auditCtx, requestId = "", deps?) {
      void requestId;
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      let body: { name?: string };
      try {
        body = (await request.json()) as { name?: string };
      } catch {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, 400, rate.headers);
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "name is required" } }, 400, rate.headers);
      }
      const { data, error } = await supabase
        .from("eval_sets")
        .insert({ workspace_id: auth.workspaceId, name })
        .select("id, name, created_at")
        .single();
      if (error) {
        if (error.code === "23505") {
          return jsonResponse({ error: { code: "CONFLICT", message: "Eval set with this name already exists" } }, 409, rate.headers);
        }
        return jsonResponse({ error: { code: "DB_ERROR", message: error.message } }, 500, rate.headers);
      }
      return jsonResponse({ id: data.id, name: data.name, created_at: data.created_at }, 201, rate.headers);
    },

    async handleAddEvalItem(request, env, supabase, evalSetId, auditCtx, requestId = "", deps?) {
      void requestId;
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      let body: { query?: string; expected_memory_ids?: string[] };
      try {
        body = (await request.json()) as { query?: string; expected_memory_ids?: string[] };
      } catch {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, 400, rate.headers);
      }
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "query is required" } }, 400, rate.headers);
      }
      const rawIds = Array.isArray(body.expected_memory_ids) ? body.expected_memory_ids : [];
      const expectedIds = rawIds.filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
      const { data: evalSet } = await supabase.from("eval_sets").select("id, workspace_id").eq("id", evalSetId).maybeSingle();
      if (!evalSet || evalSet.workspace_id !== auth.workspaceId) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "Eval set not found" } }, 404, rate.headers);
      }
      const { data, error } = await supabase
        .from("eval_items")
        .insert({ eval_set_id: evalSetId, query, expected_memory_ids: expectedIds })
        .select("id, query, expected_memory_ids, created_at")
        .single();
      if (error) {
        return jsonResponse({ error: { code: "DB_ERROR", message: error.message } }, 500, rate.headers);
      }
      return jsonResponse({ id: data.id, query: data.query, expected_memory_ids: data.expected_memory_ids, created_at: data.created_at }, 201, rate.headers);
    },

    async handleListEvalSets(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      const { data, error } = await supabase
        .from("eval_sets")
        .select("id, name, created_at")
        .eq("workspace_id", auth.workspaceId)
        .order("created_at", { ascending: false });
      if (error) {
        return jsonResponse({ error: { code: "DB_ERROR", message: error.message } }, 500, rate.headers);
      }
      return jsonResponse({ eval_sets: data ?? [] }, 200, rate.headers);
    },

    async handleRunEval(request, env, supabase, auditCtx, requestId = "", deps?) {
      void requestId;
      const d = (deps ?? defaultDeps) as EvalHandlerDeps;
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

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, 400, rate.headers);
      }

      const evalSetId = RunEvalSchema.eval_set_id(body.eval_set_id);
      const userId = RunEvalSchema.user_id(body.user_id);
      const namespace = RunEvalSchema.namespace(body.namespace);
      if (!evalSetId || !userId) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "eval_set_id and user_id are required" } },
          400,
          rate.headers,
        );
      }
      if (namespace === null) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "namespace must be a string if provided" } },
          400,
          rate.headers,
        );
      }

      const { data: evalSet, error: setErr } = await supabase
        .from("eval_sets")
        .select("id, workspace_id")
        .eq("id", evalSetId)
        .maybeSingle();
      if (setErr || !evalSet) {
        return jsonResponse(
          { error: { code: "NOT_FOUND", message: "Eval set not found" } },
          404,
          rate.headers,
        );
      }
      if (evalSet.workspace_id !== auth.workspaceId) {
        return jsonResponse(
          { error: { code: "PERMISSION_DENIED", message: "Eval set not in your workspace" } },
          403,
          rate.headers,
        );
      }

      const { data: items, error: itemsErr } = await supabase
        .from("eval_items")
        .select("id, query, expected_memory_ids")
        .eq("eval_set_id", evalSetId)
        .order("created_at", { ascending: true });
      if (itemsErr || !items?.length) {
        return jsonResponse(
          {
            eval_set_id: evalSetId,
            items: [],
            summary: { count: 0, avg_precision_at_k: 0, avg_recall: 0 },
          },
          200,
          rate.headers,
        );
      }

      const cappedItems = items.slice(0, EVAL_RUN_ITEMS_CAP);
      const totalReads = cappedItems.length;
      const totalEmbeds = cappedItems.length;
      const totalEmbedTokens = cappedItems.reduce(
        (sum, item) => sum + d.estimateEmbedTokens(String((item as { query?: string }).query ?? "").length),
        0,
      );

      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quota.blocked) {
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
      const today = d.todayUtc();
      const capResponse = await d.reserveQuotaAndMaybeRespond(
        quota,
        supabase,
        auth.workspaceId,
        today,
        {
          writesDelta: 0,
          readsDelta: totalReads,
          embedsDelta: totalEmbeds,
          embedTokensDelta: totalEmbedTokens,
          extractionCallsDelta: 0,
        },
        rateHeaders,
        env,
        jsonResponse,
      );
      if (capResponse) return capResponse;

      const results: Array<{
        item_id: string;
        query: string;
        expected: string[];
        retrieved: string[];
        precision_at_k: number;
        recall: number;
      }> = [];

      for (const item of cappedItems) {
        const expected = ((item.expected_memory_ids ?? []) as string[]).filter(Boolean);
        const outcome = await d.performSearch(
          auth,
          { user_id: userId, query: item.query, namespace, top_k: 20, explain: false },
          env,
          supabase,
        );
        const retrieved = [...new Set(outcome.results.map((r) => r.memory_id))];
        const k = Math.min(retrieved.length, 10);
        const relevantRetrieved = new Set(retrieved.filter((id) => expected.includes(id)));
        const precisionAtK = k > 0 ? relevantRetrieved.size / k : 0;
        const recall = expected.length > 0 ? relevantRetrieved.size / expected.length : 0;
        results.push({
          item_id: item.id,
          query: item.query,
          expected,
          retrieved: retrieved.slice(0, 20),
          precision_at_k: Math.round(precisionAtK * 1000) / 1000,
          recall: Math.round(recall * 1000) / 1000,
        });
      }

      const avgPrecision = results.reduce((s, r) => s + r.precision_at_k, 0) / results.length;
      const avgRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;

      return jsonResponse(
        {
          eval_set_id: evalSetId,
          items: results,
          summary: {
            count: results.length,
            avg_precision_at_k: Math.round(avgPrecision * 1000) / 1000,
            avg_recall: Math.round(avgRecall * 1000) / 1000,
          },
        },
        200,
        rateHeaders,
      );
    },
  };
}
