/**
 * Memory CRUD handlers. Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * All dependencies injected via MemoryHandlerDeps to avoid circular dependency with index.
 *
 * Phase 6 additions:
 * - memory_type column support on insert
 * - Optional lightweight extraction (extract: true) that creates child memories
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanLimits } from "@memorynodeai/shared";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit, rateLimitWorkspace } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import { MemoryInsertSchema, parseWithSchema } from "../contracts/index.js";
import type { MemoryType } from "../contracts/index.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import { createHttpError, isApiError } from "../http.js";
import {
  RETRY_MAX_ATTEMPTS,
  OPENAI_EXTRACT_RETRY_DELAYS_MS,
  EXTRACT_REQUEST_TIMEOUT_MS,
} from "../resilienceConstants.js";
import { checkGlobalCostGuard, AIBudgetExceededError } from "../costGuard.js";

export type { MemoryInsertPayload } from "../contracts/index.js";

export interface EmbedResult {
  embeddings: number[][];
  tokensUsed: number;
}

export type MetadataFilter = Record<string, string | number | boolean>;

export interface MemoryListParams {
  page: number;
  page_size: number;
  namespace?: string;
  user_id?: string;
  memory_type?: string;
  filters: {
    metadata?: MetadataFilter;
    start_time?: string;
    end_time?: string;
  };
}

export interface ListOutcome {
  results: {
    id: string;
    user_id: string;
    namespace: string;
    text: string;
    metadata: Record<string, unknown>;
    created_at: string;
    memory_type?: string | null;
    source_memory_id?: string | null;
  }[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface MemoryHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  chunkText: (text: string) => string[];
  embedText: (texts: string[], env: Env) => Promise<EmbedResult>;
  todayUtc: () => string;
  vectorToPgvectorString: (vector: number[]) => string;
  emitProductEvent: (
    supabase: SupabaseClient,
    eventName: string,
    ctx: { workspaceId?: string; requestId?: string; route?: string; method?: string; status?: number; effectivePlan?: AuthContext["plan"]; planStatus?: AuthContext["planStatus"] },
    props?: Record<string, unknown>,
    ensureUnique?: boolean,
  ) => Promise<void>;
  bumpUsage: (
    supabase: SupabaseClient,
    workspaceId: string,
    day: string,
    deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
  ) => Promise<unknown>;
  effectivePlan: (plan: AuthContext["plan"], status?: AuthContext["planStatus"]) => AuthContext["plan"];
  normalizeMemoryListParams: (url: URL) => MemoryListParams;
  performListMemories: (auth: AuthContext, params: MemoryListParams, supabase: SupabaseClient) => Promise<ListOutcome>;
  deleteMemoryCascade: (supabase: SupabaseClient, workspaceId: string, memoryId: string) => Promise<boolean>;
  checkCapsAndMaybeRespond: (
    jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
    auth: AuthContext,
    supabase: SupabaseClient,
    deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
    rateHeaders: Record<string, string> | undefined,
    env: Env,
    logCtx?: { requestId?: string; route?: string; method?: string },
  ) => Promise<Response | null>;
  resolveQuotaForWorkspace: (auth: AuthContext, supabase: SupabaseClient) => Promise<QuotaResolutionLike>;
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
  planLimitExceededResponse: (
    limit: string,
    used: number,
    cap: number,
    rateHeaders: Record<string, string> | undefined,
    jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
    env: Env,
  ) => Response;
  estimateEmbedTokens: (textLength: number) => number;
}

export interface QuotaResolutionLike {
  planLimits: PlanLimits;
  blocked: boolean;
  degradedEntitlements?: boolean;
  /** launch|build|deploy|scale|scale_plus|free — from workspace entitlements when present */
  effectivePlan?: string;
  errorCode?: string;
  message?: string;
  expiredAt?: string | null;
}

const DEFAULT_NAMESPACE = "default";

const EXTRACTION_PROMPT = `You are a memory extraction assistant. Given the user's text, extract distinct facts, preferences, and events as a JSON array.

Each item must have:
- "text": the extracted statement (concise, standalone, one sentence)
- "memory_type": one of "fact", "preference", "event"

Return ONLY a JSON array. If nothing can be extracted, return [].

Examples:
Input: "I love Thai food and I'm allergic to peanuts. Last Tuesday I visited Bangkok."
Output: [{"text":"User loves Thai food","memory_type":"preference"},{"text":"User is allergic to peanuts","memory_type":"fact"},{"text":"User visited Bangkok last Tuesday","memory_type":"event"}]`;

interface ExtractedItem {
  text: string;
  memory_type: MemoryType;
}

/**
 * Call a cheap LLM to extract facts/preferences/events from text.
 * Retries up to 2 times with exponential backoff. Throws on failure (structured error).
 */
/** Max extracted child memories per parent (extractAndStore). Used for quota reservation. */
export const MAX_EXTRACT_ITEMS = 10;
/** Conservative max chunks per extracted item (one sentence ≈ 1–2 chunks). Used to reserve embed quota up front. */
const MAX_CHUNKS_PER_EXTRACTED_ITEM = 2;
/** ~200 tokens per embed (align with shared TOKENS_PER_EMBED_ASSUMED). Used for extraction child embed token reserve. */
const TOKENS_PER_EMBED = 200;

async function extractItems(text: string, env: Env): Promise<ExtractedItem[]> {
  if (!env.OPENAI_API_KEY) {
    throw createHttpError(503, "EXTRACTION_ERROR", "OPENAI_API_KEY not configured");
  }
  const maxAttempts = RETRY_MAX_ATTEMPTS;
  const delaysMs = OPENAI_EXTRACT_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXTRACT_REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          max_tokens: 1024,
          messages: [
            { role: "system", content: EXTRACTION_PROMPT },
            { role: "user", content: text },
          ],
        }),
      });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        await resp.text();
        throw createHttpError(
          resp.status >= 500 ? 503 : 400,
          "EXTRACTION_ERROR",
          `Extraction service returned HTTP ${resp.status}`,
        );
      }
      const json = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const raw = json.choices?.[0]?.message?.content?.trim() ?? "";
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const valid: ExtractedItem[] = [];
      for (const item of parsed) {
        if (
          typeof item === "object" && item &&
          typeof item.text === "string" && item.text.length > 0 &&
          typeof item.memory_type === "string" &&
          ["fact", "preference", "event"].includes(item.memory_type)
        ) {
          valid.push({ text: item.text, memory_type: item.memory_type as MemoryType });
        }
        if (valid.length >= MAX_EXTRACT_ITEMS) break;
      }
      return valid;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (isApiError(err)) throw err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delaysMs[attempt] ?? 500));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        throw createHttpError(503, "EXTRACTION_ERROR", `Extraction failed: ${msg}`);
      }
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw createHttpError(503, "EXTRACTION_ERROR", `Extraction failed: ${msg}`);
}

/**
 * Extract items from source text and store as child memories.
 * Returns counts for observability. Failures are logged and emitted as product events.
 *
 * Quota: Child writes/embeds/embed_tokens are NOT bumped here. The caller (handleCreateMemory)
 * reserves the maximum possible extraction cost (1 + MAX_EXTRACT_ITEMS writes, parent + child
 * embeds/tokens, 1 extraction call) in a single atomic reserveQuotaAndMaybeRespond BEFORE any
 * embed or insert. No embedText or insert runs without that prior reservation.
 */
async function extractAndStore(
  env: Env,
  supabase: SupabaseClient,
  d: MemoryHandlerDeps,
  sourceMemoryId: string,
  workspaceId: string,
  userId: string,
  namespace: string,
  text: string,
): Promise<{ children_created: number; skipped: boolean; error?: string }> {
  if (!env.OPENAI_API_KEY) {
    return { children_created: 0, skipped: true, error: "OPENAI_API_KEY not configured" };
  }

  let totalWrites = 0;
  try {
    const items = await extractItems(text, env);
    if (items.length === 0) return { children_created: 0, skipped: false };

    for (const item of items) {
      const chunks = d.chunkText(item.text);
      const embedResult = await d.embedText(chunks, env);
      const embeddings = embedResult.embeddings;

      const { data: childInsert, error: childError } = await supabase
        .from("memories")
        .insert({
          workspace_id: workspaceId,
          user_id: userId,
          namespace,
          text: item.text,
          metadata: { _extracted: true, _source_memory_id: sourceMemoryId },
          memory_type: item.memory_type,
          source_memory_id: sourceMemoryId,
        })
        .select("id")
        .single();

      if (childError || !childInsert) continue;

      const childId = childInsert.id as string;
      const chunkRows = chunks.map((chunk, idx) => ({
        workspace_id: workspaceId,
        memory_id: childId,
        user_id: userId,
        namespace,
        chunk_index: idx,
        chunk_text: chunk,
        embedding: d.vectorToPgvectorString(embeddings[idx]),
      }));

      const { error: chunkInsertError } = await supabase.from("memory_chunks").insert(chunkRows);
      if (chunkInsertError) {
        console.error("[extraction] chunk insert failed, removing orphan memory", {
          child_memory_id: childId,
          source_memory_id: sourceMemoryId,
          error: chunkInsertError.message,
        });
        await supabase.from("memories").delete().eq("id", childId).eq("workspace_id", workspaceId);
        continue;
      }

      totalWrites++;
    }

    return { children_created: totalWrites, skipped: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[extraction] extractAndStore failed", {
      source_memory_id: sourceMemoryId,
      workspace_id: workspaceId,
      error: msg,
    });
    return { children_created: totalWrites, skipped: false, error: msg };
  }
}

export function createMemoryHandlers(
  requestDeps: MemoryHandlerDeps,
  defaultDeps: MemoryHandlerDeps,
): {
  handleCreateMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleListMemories: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    url: URL,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleGetMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    memoryId: string,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDeleteMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    memoryId: string,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleCreateMemory(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      auditCtx.workspaceId = auth.workspaceId;
      requireWorkspaceId(auth.workspaceId);
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
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }
      const wsRpm = quota.planLimits.workspace_rpm ?? 120;
      const wsRate = await rateLimitWorkspace(auth.workspaceId, wsRpm, env);
      if (!wsRate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
          429,
          { ...rate.headers, ...wsRate.headers },
        );
      }
      const rateHeaders = { ...rate.headers, ...wsRate.headers };

      const parseResult = await parseWithSchema(MemoryInsertSchema, request);
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

      const { user_id, text, metadata, namespace, memory_type, extract } = parseResult.data;
      const namespaceVal = namespace ?? DEFAULT_NAMESPACE;

      if (text.length > quota.planLimits.max_text_chars) {
        return d.planLimitExceededResponse(
          "max_text_chars",
          text.length,
          quota.planLimits.max_text_chars,
          rateHeaders,
          jsonResponse,
          env,
        );
      }
      if (extract && quota.planLimits.extraction_calls_per_day === 0) {
        return d.planLimitExceededResponse(
          "extraction_calls",
          0,
          0,
          rateHeaders,
          jsonResponse,
          env,
        );
      }
      const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toLowerCase();
      const enforceDegradedBlocks = stage === "production" || stage === "prod" || stage === "staging";
      if (extract && enforceDegradedBlocks && quota.degradedEntitlements) {
        return jsonResponse(
          {
            error: {
              code: "ENTITLEMENT_DEGRADED",
              message: "Extraction is temporarily unavailable while entitlement checks recover.",
            },
          },
          503,
          rateHeaders,
        );
      }

      const chunks = d.chunkText(text);
      const chunkCount = chunks.length;
      const estimatedEmbedTokens = chunks.reduce((sum, ch) => sum + d.estimateEmbedTokens(ch.length), 0);

      const today = d.todayUtc();
      // When extract is true, reserve the maximum possible extraction cost up front so that no
      // child embed or insert runs without quota. This uses the same atomic cap check as all other
      // paths; we never call bump_usage_rpc for extraction children.
      const extractWrites = extract ? MAX_EXTRACT_ITEMS : 0;
      const extractEmbeds = extract ? MAX_EXTRACT_ITEMS * MAX_CHUNKS_PER_EXTRACTED_ITEM : 0;
      const extractEmbedTokens = extract ? extractEmbeds * TOKENS_PER_EMBED : 0;
      const reserveResult = await d.reserveQuotaAndMaybeRespond(
        quota,
        supabase,
        auth.workspaceId,
        today,
        {
          writesDelta: 1 + extractWrites,
          readsDelta: 0,
          embedsDelta: chunkCount + extractEmbeds,
          embedTokensDelta: estimatedEmbedTokens + extractEmbedTokens,
          extractionCallsDelta: extract ? 1 : 0,
        },
        rateHeaders,
        env,
        jsonResponse,
        { route: "/v1/memories", requestId },
      );
      if (reserveResult.response) return reserveResult.response;
      const reservationId = reserveResult.reservationId;

      try {
        await checkGlobalCostGuard(supabase, env);
      } catch (e) {
        if (e instanceof AIBudgetExceededError) {
          if (reservationId) {
            await d.markUsageReservationRefundPending(
              supabase,
              reservationId,
              "ai_budget_exceeded_pre_embed",
            );
          }
          return jsonResponse(
            {
              error: {
                code: "ai_budget_exceeded",
                message: "AI usage temporarily paused due to budget protection.",
              },
            },
            503,
            rateHeaders,
          );
        }
        throw e;
      }

      let embedResult: EmbedResult;
      try {
        embedResult = await d.embedText(chunks, env);
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
      const embeddings = embedResult.embeddings;
      const actualEmbedTokens = embedResult.tokensUsed;

      if (actualEmbedTokens > estimatedEmbedTokens) {
        const tokenDelta = actualEmbedTokens - estimatedEmbedTokens;
        try {
          await supabase.rpc("record_usage_event_if_within_cap", {
            p_workspace_id: auth.workspaceId,
            p_day: today,
            p_idempotency_key: `embed-reconcile:${requestId || "unknown"}:${tokenDelta}`,
            p_request_id: requestId || null,
            p_route: "/v1/memories",
            p_actor_type: "api_key",
            p_actor_id: null,
            p_writes: 0,
            p_reads: 0,
            p_embeds: 0,
            p_embed_tokens: tokenDelta,
            p_extraction_calls: 0,
            p_gen_input_tokens: 0,
            p_gen_output_tokens: 0,
            p_storage_bytes: 0,
            p_estimated_cost_inr: 0,
            p_billable: true,
            p_metadata: {},
            p_writes_cap: quota.planLimits.writes_per_day,
            p_reads_cap: quota.planLimits.reads_per_day,
            p_embeds_cap: Math.floor(quota.planLimits.embed_tokens_per_day / 200),
            p_embed_tokens_cap: quota.planLimits.embed_tokens_per_day,
            p_extraction_calls_cap: quota.planLimits.extraction_calls_per_day,
            p_gen_tokens_cap: Math.max(0, quota.planLimits.included_gen_tokens ?? 0),
            p_storage_bytes_cap: Math.floor(Math.max(0, quota.planLimits.included_storage_gb ?? 0) * 1_000_000_000),
          });
        } catch {
          /* best-effort reconciliation; pre-flight estimate already enforced the cap */
        }
      }

      const { data: memoryInsert, error: memoryError } = await supabase
        .from("memories")
        .insert({
          workspace_id: auth.workspaceId,
          user_id,
          namespace: namespaceVal,
          text,
          metadata: metadata ?? {},
          ...(memory_type ? { memory_type } : {}),
        })
        .select("id")
        .single();

      if (memoryError || !memoryInsert) {
        if (reservationId) {
          await d.markUsageReservationRefundPending(
            supabase,
            reservationId,
            memoryError?.message ?? "memory_insert_failed",
          );
        }
        return jsonResponse(
          {
            error: {
              code: "DB_ERROR",
              message: memoryError?.message ?? "Failed to insert memory",
            },
          },
          500,
          rateHeaders,
        );
      }

      const memoryId = memoryInsert.id as string;

      const rows = chunks.map((chunk, idx) => ({
        workspace_id: auth.workspaceId,
        memory_id: memoryId,
        user_id,
        namespace: namespaceVal,
        chunk_index: idx,
        chunk_text: chunk,
        embedding: d.vectorToPgvectorString(embeddings[idx]),
      }));

      const { error: chunkError } = await supabase.from("memory_chunks").insert(rows);
      if (chunkError) {
        if (reservationId) {
          await d.markUsageReservationRefundPending(
            supabase,
            reservationId,
            chunkError.message ?? "chunk_insert_failed",
          );
        }
        return jsonResponse(
          { error: { code: "DB_ERROR", message: chunkError.message ?? "Failed to insert chunks" } },
          500,
          rateHeaders,
        );
      }

      let extractionResult: { children_created: number; skipped: boolean; error?: string } | undefined;
      if (extract) {
        try {
          await checkGlobalCostGuard(supabase, env);
        } catch (e) {
          if (e instanceof AIBudgetExceededError) {
            if (reservationId) {
              await d.markUsageReservationRefundPending(
                supabase,
                reservationId,
                "ai_budget_exceeded_pre_extract",
              );
            }
            return jsonResponse(
              {
                error: {
                  code: "ai_budget_exceeded",
                  message: "AI usage temporarily paused due to budget protection.",
                },
              },
              503,
              rateHeaders,
            );
          }
          throw e;
        }
        extractionResult = await extractAndStore(env, supabase, d, memoryId, auth.workspaceId, user_id, namespaceVal, text);

        if (extractionResult.error) {
          if (reservationId) {
            await d.markUsageReservationRefundPending(
              supabase,
              reservationId,
              extractionResult.error,
            );
          }
          return jsonResponse(
            { error: { code: "EXTRACTION_ERROR", message: extractionResult.error } },
            503,
            rateHeaders,
          );
        }

        void d.emitProductEvent(
          supabase,
          "extraction_completed",
          {
            workspaceId: auth.workspaceId,
            requestId,
            route: "/v1/memories",
            method: "POST",
            status: 200,
          },
          {
            source_memory_id: memoryId,
            children_created: extractionResult.children_created,
            skipped: extractionResult.skipped,
            error: extractionResult.error ?? null,
          },
        );
      }

      void d.emitProductEvent(
        supabase,
        "first_ingest_success",
        {
          workspaceId: auth.workspaceId,
          requestId,
          route: "/v1/memories",
          method: "POST",
          status: 200,
          effectivePlan: d.effectivePlan(auth.plan, auth.planStatus),
          planStatus: auth.planStatus,
        },
        { body_bytes: Number(request.headers.get("content-length") ?? "0") || undefined },
        true,
      );

      /* Quota already reserved via reserveQuotaAndMaybeRespond */
      const response: Record<string, unknown> = { memory_id: memoryId, chunks: rows.length };
      if (extractionResult) {
        response.extraction = {
          triggered: true,
          children_created: extractionResult.children_created,
          skipped: extractionResult.skipped,
          ...(extractionResult.error ? { error: extractionResult.error } : {}),
        };
      }

      if (reservationId) {
        await d.markUsageReservationCommitted(supabase, reservationId);
      }
      return jsonResponse(response, 200, rateHeaders);
    },

    async handleListMemories(request, env, supabase, url, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
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
      const wsRate = await rateLimitWorkspace(auth.workspaceId, wsRpm, env);
      if (!wsRate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
          429,
          { ...rate.headers, ...wsRate.headers },
        );
      }
      const rateHeaders = { ...rate.headers, ...wsRate.headers };

      const params = d.normalizeMemoryListParams(url);
      const result = await d.performListMemories(auth, params, supabase);

      return jsonResponse(
        {
          results: result.results,
          page: result.page,
          page_size: result.page_size,
          total: result.total,
          has_more: result.has_more,
        },
        200,
        rateHeaders,
      );
    },

    async handleGetMemory(request, env, supabase, memoryId, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
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

      const { data, error } = await supabase
        .from("memories")
        .select("id, user_id, namespace, text, metadata, created_at, memory_type, source_memory_id")
        .eq("workspace_id", auth.workspaceId)
        .eq("id", memoryId)
        .maybeSingle();

      if (error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error.message ?? "Failed to fetch memory" } },
          500,
          rate.headers,
        );
      }

      if (!data) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "Memory not found" } }, 404, rate.headers);
      }

      return jsonResponse(data, 200, rate.headers);
    },

    async handleDeleteMemory(request, env, supabase, memoryId, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
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

      const deleted = await d.deleteMemoryCascade(supabase, auth.workspaceId, memoryId);
      if (!deleted) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "Memory not found" } }, 404, rate.headers);
      }

      return jsonResponse({ deleted: true, id: memoryId }, 200, rate.headers);
    },
  };
}
