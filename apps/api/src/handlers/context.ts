/**
 * Context handler (search-derived context_text + citations). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * Uses same deps as search (performSearch, caps, events). Dependencies injected via ContextHandlerDeps.
 *
 * Smart context assembly:
 * 1. Merge adjacent chunks from the same memory (consecutive chunk_index values).
 * 2. Deduplicate overlapping text (substring containment and word-set Jaccard).
 * 3. Preserve citations and memory IDs.
 * Endpoint shape is unchanged — context_text + citations.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import {
  acquireWorkspaceConcurrencySlot,
  authenticate,
  rateLimit,
  releaseWorkspaceConcurrencySlot,
} from "../auth.js";
import { getRouteRateLimitMax, MCP_CONTEXT_BUDGET_CHARS } from "../limits.js";
import type { HandlerDeps } from "../router.js";
import type { SearchHandlerDeps } from "./search.js";
import { SearchPayloadSchema, parseWithSchema } from "../contracts/index.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import { enforceIsolation } from "../middleware/isolation.js";
import { logger } from "../logger.js";
import { budgetContextBlocks, applyCostAwareRetrievalCap } from "../search/contextBudget.js";
import { recordFeedbackWithClient } from "../learning/feedback.js";

export type ContextHandlerDeps = SearchHandlerDeps;

export interface SearchResultItem {
  chunk_id: string;
  memory_id: string;
  chunk_index: number;
  text: string;
  score: number;
}

export interface MergedBlock {
  text: string;
  chunk_ids: string[];
  memory_ids: string[];
  chunk_indices: number[];
}

export const JACCARD_DEDUP_THRESHOLD = 0.75;

export function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean));
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

export function isSubstringOf(shorter: string, longer: string): boolean {
  const a = shorter.trim().toLowerCase();
  const b = longer.trim().toLowerCase();
  return b.includes(a);
}

/**
 * Merge adjacent chunks from the same memory, then deduplicate overlapping blocks.
 * Preserves all chunk_ids and memory_ids for citation.
 */
export function assembleSmartContext(results: SearchResultItem[]): MergedBlock[] {
  if (results.length === 0) return [];

  const grouped = new Map<string, SearchResultItem[]>();
  for (const r of results) {
    const list = grouped.get(r.memory_id) ?? [];
    list.push(r);
    grouped.set(r.memory_id, list);
  }

  const merged: MergedBlock[] = [];

  for (const [, items] of grouped) {
    items.sort((a, b) => a.chunk_index - b.chunk_index);

    let block: MergedBlock = {
      text: items[0].text,
      chunk_ids: [items[0].chunk_id],
      memory_ids: [items[0].memory_id],
      chunk_indices: [items[0].chunk_index],
    };

    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const cur = items[i];
      if (cur.chunk_index === prev.chunk_index + 1) {
        block.text = block.text + "\n" + cur.text;
        block.chunk_ids.push(cur.chunk_id);
        if (!block.memory_ids.includes(cur.memory_id)) {
          block.memory_ids.push(cur.memory_id);
        }
        block.chunk_indices.push(cur.chunk_index);
      } else {
        merged.push(block);
        block = {
          text: cur.text,
          chunk_ids: [cur.chunk_id],
          memory_ids: [cur.memory_id],
          chunk_indices: [cur.chunk_index],
        };
      }
    }
    merged.push(block);
  }

  merged.sort((a, b) => {
    const scoreA = results.findIndex((r) => r.chunk_id === a.chunk_ids[0]);
    const scoreB = results.findIndex((r) => r.chunk_id === b.chunk_ids[0]);
    return scoreA - scoreB;
  });

  const deduped: MergedBlock[] = [];
  const wordSets: Set<string>[] = [];

  for (const block of merged) {
    if (!block.text.trim()) {
      deduped.push(block);
      wordSets.push(new Set());
      continue;
    }

    let isDuplicate = false;
    const blockWords = wordSet(block.text);

    for (let i = 0; i < deduped.length; i++) {
      if (!deduped[i].text.trim()) continue;
      if (isSubstringOf(block.text, deduped[i].text) || isSubstringOf(deduped[i].text, block.text)) {
        if (block.text.length > deduped[i].text.length) {
          deduped[i] = block;
          wordSets[i] = blockWords;
        }
        isDuplicate = true;
        break;
      }
      if (jaccardSimilarity(blockWords, wordSets[i]) >= JACCARD_DEDUP_THRESHOLD) {
        if (block.text.length > deduped[i].text.length) {
          deduped[i] = block;
          wordSets[i] = blockWords;
        }
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      deduped.push(block);
      wordSets.push(blockWords);
    }
  }

  return deduped;
}

export function createContextHandlers(
  requestDeps: ContextHandlerDeps,
  defaultDeps: ContextHandlerDeps,
): {
  handleContext: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleContext(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as ContextHandlerDeps;
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
      const rateHeadersWithRouting = { ...rateHeaders, ...isolationResolution.responseHeaders };
      parseResult.data.user_id = isolationResolution.isolation.ownerId;
      parseResult.data.owner_id = isolationResolution.isolation.ownerId;
      parseResult.data.namespace = isolationResolution.isolation.containerTag;
      const usageToday = await supabase
        .from("usage_daily")
        .select("reads")
        .eq("workspace_id", auth.workspaceId)
        .eq("day", d.todayUtc())
        .maybeSingle();
      const readsToday = Number((usageToday.data as { reads?: number } | null)?.reads ?? 0);
      const readCap = Math.max(1, quota.planLimits.reads_per_day);
      const budgetPressure = Math.min(1, readsToday / readCap);
      const cappedRetrieval = applyCostAwareRetrievalCap({
        requestedTopK: parseResult.data.top_k,
        requestedPageSize: parseResult.data.page_size,
        budgetPressure,
      });
      if (cappedRetrieval.topK !== undefined) parseResult.data.top_k = cappedRetrieval.topK;
      if (cappedRetrieval.pageSize !== undefined) parseResult.data.page_size = cappedRetrieval.pageSize;

      const searchMode = parseResult.data.search_mode ?? "hybrid";
      const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toLowerCase();
      const enforceDegradedBlocks = stage === "production" || stage === "prod" || stage === "staging";
      if (enforceDegradedBlocks && quota.degradedEntitlements && searchMode !== "keyword") {
        return jsonResponse(
          {
            error: {
              code: "ENTITLEMENT_DEGRADED",
              message: "Semantic context is temporarily unavailable while entitlement checks recover.",
            },
          },
          503,
          rateHeadersWithRouting,
        );
      }
      const embedsDelta = searchMode === "keyword" ? 0 : 1;
      const embedTokensDelta = d.estimateEmbedTokens(parseResult.data.query.length);
      const today = d.todayUtc();
      const concurrency = await acquireWorkspaceConcurrencySlot(auth.workspaceId, env);
      if (!concurrency.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace in-flight concurrency limit exceeded" } },
          429,
          { ...rateHeadersWithRouting, ...concurrency.headers },
        );
      }
      const concurrencyHeaders = { ...rateHeadersWithRouting, ...concurrency.headers };
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
        { route: "/v1/context", requestId },
      );
      if (reserveResult.response) return reserveResult.response;
      const reservationId = reserveResult.reservationId;

      let outcome;
      const contextStartMs = Date.now();
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
      const blocks = assembleSmartContext(outcome.results);
      const budgetedBlocks = budgetContextBlocks(blocks, {
        maxTokens: Math.max(180, Math.floor(MCP_CONTEXT_BUDGET_CHARS / 4)),
        fallbackScore: 0.72,
        confidence: 0.66,
        priorityScore: 0.68,
      });

      const lines: string[] = [];
      const citations: { i: number; chunk_id: string; memory_id: string; chunk_index: number }[] = [];

      let citationIdx = 1;
      for (const block of budgetedBlocks) {
        lines.push(`[-${citationIdx}-] ${block.text}`);
        for (let j = 0; j < block.chunk_ids.length; j++) {
          citations.push({
            i: citationIdx,
            chunk_id: block.chunk_ids[j],
            memory_id: block.memory_ids[Math.min(j, block.memory_ids.length - 1)],
            chunk_index: block.chunk_indices[j],
          });
        }
        citationIdx++;
      }

      void d.emitProductEvent(
        supabase,
        "first_context_success",
        {
          workspaceId: auth.workspaceId,
          requestId,
          route: "/v1/context",
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
        "context_executed",
        {
          workspaceId: auth.workspaceId,
          requestId,
          route: "/v1/context",
          method: "POST",
          status: 200,
          effectivePlan: d.effectivePlan(auth.plan, auth.planStatus),
          planStatus: auth.planStatus,
        },
        {
          avg_retrieved_count: outcome.results.length,
          reranker_usage_rate: outcome.retrieval_trace?.reranker_applied === true ? 1 : 0,
          summary_usage_rate: Number(outcome.retrieval_trace?.summary_count_in_capped_window ?? 0) > 0 ? 1 : 0,
          result_total: outcome.total,
        },
      );

      if (reservationId) {
        await d.markUsageReservationCommitted(supabase, reservationId);
      }
      let profile;
      try {
        profile = await d.fetchBoundedContextProfile(auth, supabase, {
          user_id: parseResult.data.user_id,
          namespace: parseResult.data.namespace,
        });
      } catch (e) {
        logger.info({
          event: "context_profile_failed",
          request_id: requestId,
          message: e instanceof Error ? e.message : String(e),
        });
        profile = { pinned_facts: [], recent_notes: [], preferences: [] };
      }
      let linked_memories: Array<{
        memory_id: string;
        text: string;
        link_type: string;
        from_memory_id: string;
      }> = [];
      try {
        linked_memories = await d.expandContextLinkedMemories(auth, supabase, {
          user_id: parseResult.data.user_id,
          namespace: parseResult.data.namespace,
          seed_memory_ids: [...new Set(outcome.results.map((r) => r.memory_id))],
        });
      } catch (e) {
        logger.info({
          event: "context_linked_memories_failed",
          request_id: requestId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      void recordFeedbackWithClient(supabase, auth.workspaceId, requestId, {
        query: parseResult.data.query,
        retrieved_memory_ids: [...new Set(outcome.results.map((r) => r.memory_id))],
        final_response: lines.join("\n\n").slice(0, 8000),
        latency_ms: Date.now() - contextStartMs,
      });
      return jsonResponse(
        {
          context_text: lines.join("\n\n"),
          citations,
          context_blocks: budgetedBlocks.length,
          /** total/has_more reflect the underlying search result set before merge/dedup. */
          page: outcome.page,
          page_size: outcome.page_size,
          total: outcome.total,
          has_more: outcome.has_more,
          profile,
          linked_memories,
        },
        200,
        concurrencyHeaders,
      );
      } finally {
        await releaseWorkspaceConcurrencySlot(auth.workspaceId, concurrency.leaseToken, env);
      }
    },
  };
}
