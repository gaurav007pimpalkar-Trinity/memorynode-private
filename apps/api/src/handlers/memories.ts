/**
 * Memory CRUD handlers. Dependencies are injected via MemoryHandlerDeps to avoid circular imports.
 *
 * Supports optional LLM extraction (`extract`, default true) that creates child memories without failing the parent write.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeInternalCredits,
  detectPiiHints,
  estimateCostInr,
  type PlanLimits,
} from "@memorynodeai/shared";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import {
  acquireWorkspaceConcurrencySlot,
  authenticate,
  isTrustedInternal,
  rateLimit,
  rateLimitWorkspace,
  releaseWorkspaceConcurrencySlot,
} from "../auth.js";
import type { HandlerDeps } from "../router.js";
import {
  ConversationInsertSchema,
  MemoryInsertSchema,
  ProfilePinsPatchSchema,
  parseWithSchema,
} from "../contracts/index.js";
import type { ChunkProfile, MemoryType } from "../contracts/index.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import { createHttpError, isApiError } from "../http.js";
import {
  RETRY_MAX_ATTEMPTS,
  OPENAI_EXTRACT_RETRY_DELAYS_MS,
  EXTRACT_REQUEST_TIMEOUT_MS,
} from "../resilienceConstants.js";
import { checkGlobalCostGuard, AIBudgetExceededError } from "../costGuard.js";
import { decideExtraction, type ExtractionSkipReason } from "../memories/extractionPolicy.js";
import { logger } from "../logger.js";
import { enforceIsolation } from "../middleware/isolation.js";
import {
  computeIntelligenceScore,
  deterministicExtractFallback,
  normalizeExtractedCandidates,
  normalizeTextForMemoryKey,
  semanticFingerprintFromText,
  estimateNoveltyScore,
  deriveSourceWeight,
  type ConflictState,
} from "../memories/intelligence.js";
import { createMemoryRevision, detectAndResolveConflict } from "../memories/conflictResolution.js";
import { evaluateIngestAbuse, writeIngestControlEvent } from "../memories/ingestAbuse.js";
import { updateProfileSnapshot } from "../profile/profileSynthesis.js";

export type { MemoryInsertPayload } from "../contracts/index.js";

function mergeMetadataPinned(meta: unknown, pinned: boolean): Record<string, unknown> {
  const base =
    meta && typeof meta === "object" && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
  if (pinned) {
    base.pinned = true;
  } else {
    delete base.pinned;
  }
  return base;
}

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
  owner_id?: string;
  owner_type?: "user" | "team" | "app";
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
    confidence?: number;
    source_weight?: number;
    priority_score?: number;
    priority_tier?: "cold" | "warm" | "hot" | "critical";
    pinned_auto?: boolean;
    conflict_state?: ConflictState;
    last_conflict_at?: string | null;
  }[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export interface MemoryHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  chunkText: (text: string, profile?: ChunkProfile) => string[];
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
  getMemoryByIdScoped: (
    supabase: SupabaseClient,
    workspaceId: string,
    memoryId: string,
  ) => Promise<ListOutcome["results"][number] | null>;
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
  grace_soft_downgrade?: boolean;
  /** launch|build|deploy|scale|scale_plus — from workspace entitlements when present */
  effectivePlan?: string;
  errorCode?: string;
  message?: string;
  expiredAt?: string | null;
}

const DEFAULT_NAMESPACE = "default";
const AUTO_SAVE_KEYWORDS = [
  "prefer",
  "preference",
  "always",
  "never",
  "allergic",
  "project",
  "deadline",
  "goal",
  "working on",
  "do not",
  "timezone",
];
const ALLOWED_ATTACHMENT_TYPES = new Set(["pdf", "docx", "txt", "md", "html", "csv", "tsv", "xlsx", "pptx", "eml", "msg"]);
/** Not supported in product scope (no images/video pipeline). */
const BANNED_ATTACHMENT_TYPES = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico",
  "mp4", "webm", "mov", "avi", "mkv", "m4v",
]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function normalizeTextKey(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function shouldAutoSaveMemory(args: { text: string; memoryType?: string; metadata?: Record<string, unknown> }): boolean {
  const text = args.text.trim();
  if (text.length < 24) return false;
  if (args.memoryType && args.memoryType !== "note") return true;
  if (args.metadata?.force_save === true) return true;
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean).length;
  if (words < 5) return false;
  return AUTO_SAVE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

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
  confidence?: number;
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
function estimateEmbedTokenCostInr(embedTokens: number, env: Env): number {
  return estimateCostInr(
    { embed_tokens: embedTokens },
    {
      usd_to_inr: Number(env.USD_TO_INR),
      drift_multiplier: Number(env.COST_DRIFT_MULTIPLIER),
    },
  );
}

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
      if (!Array.isArray(parsed)) return deterministicExtractFallback(text);
      const valid = normalizeExtractedCandidates(parsed).slice(0, MAX_EXTRACT_ITEMS);
      return valid.length > 0 ? valid : deterministicExtractFallback(text);
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (isApiError(err)) throw err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delaysMs[attempt] ?? 500));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        return deterministicExtractFallback(text);
      }
    }
  }
  void lastError;
  return deterministicExtractFallback(text);
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
  ownerId: string,
  ownerType: "user" | "team" | "app",
  namespace: string,
  text: string,
  maxPersistItems: number,
  effectiveAtIso: string,
): Promise<{ children_created: number; skipped: boolean; error?: string }> {
  if (!env.OPENAI_API_KEY) {
    return { children_created: 0, skipped: true, error: "OPENAI_API_KEY not configured" };
  }

  let totalWrites = 0;
  try {
    const itemsAll = await extractItems(text, env);
    const items = itemsAll.slice(0, Math.max(0, maxPersistItems));
    if (items.length === 0) return { children_created: 0, skipped: false };

    for (const item of items) {
      const chunks = d.chunkText(item.text);
      const embedResult = await d.embedText(chunks, env);
      const embeddings = embedResult.embeddings;
      const normalized = normalizeTextForMemoryKey(item.text);
      const canonicalHash = await sha256Hex(`${workspaceId}:${ownerId}:${namespace}:${item.memory_type}:${normalized}`);
      const sourceWeight = 0.9;
      const intelligence = computeIntelligenceScore({
        text: item.text,
        memoryType: item.memory_type,
        extractionConfidence: item.confidence ?? 0.62,
        sourceWeight,
        noveltyScore: 0.6,
      });

      const { data: childInsert, error: childError } = await supabase
        .from("memories")
        .insert({
          workspace_id: workspaceId,
          user_id: ownerId,
          owner_id: ownerId,
          owner_type: ownerType,
          namespace,
          text: item.text,
          metadata: { _extracted: true, _source_memory_id: sourceMemoryId },
          memory_type: item.memory_type,
          source_memory_id: sourceMemoryId,
          effective_at: effectiveAtIso,
          canonical_hash: canonicalHash,
          semantic_fingerprint: semanticFingerprintFromText(item.text),
          confidence: intelligence.confidence,
          source_weight: sourceWeight,
          priority_score: intelligence.priorityScore,
          priority_tier: intelligence.priorityTier,
          pinned_auto: false,
          conflict_state: "none",
          importance: Math.max(0.2, 0.8 + intelligence.priorityScore * 1.3),
        })
        .select("id")
        .single();

      if (childError || !childInsert) continue;

      const childId = childInsert.id as string;
      const chunkRows = chunks.map((chunk, idx) => ({
        workspace_id: workspaceId,
        memory_id: childId,
        user_id: ownerId,
        owner_id: ownerId,
        owner_type: ownerType,
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
  handleCreateConversation: (
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
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleGetMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    memoryId: string,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
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
  handlePatchProfilePins: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  const handleCreateMemoryImpl = async (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId = "",
    deps?: HandlerDeps,
  ) => {
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
              code: quota.errorCode ?? "ENTITLEMENT_REQUIRED",
              message: quota.message ?? "No active paid entitlement found. Start a plan to continue quota-consuming API calls.",
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
      let rateHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
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
        rateHeaders = { ...rate.headers, ...wsRate.headers };
      }

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

      const {
        owner_type,
        text,
        metadata,
        memory_type,
        extract,
        importance,
        chunk_profile,
        replaces_memory_id,
        effective_at: effectiveAtRaw,
        idempotency_key,
      } = parseResult.data;
      const ownerId = isolationResolution.isolation.ownerId;
      const ownerType = owner_type ?? "user";
      const namespaceVal = isolationResolution.isolation.containerTag ?? DEFAULT_NAMESPACE;
      const effectiveAtIso = effectiveAtRaw?.trim()
        ? new Date(effectiveAtRaw.trim()).toISOString()
        : new Date().toISOString();

      if (replaces_memory_id) {
        const { data: repRow, error: repErr } = await supabase
          .from("memories")
          .select("id,user_id,namespace,duplicate_of")
          .eq("id", replaces_memory_id)
          .eq("workspace_id", auth.workspaceId)
          .maybeSingle();
        if (repErr || !repRow) {
          return jsonResponse(
            { error: { code: "BAD_REQUEST", message: "replaces_memory_id not found in this workspace" } },
            400,
            rateHeaders,
          );
        }
        if (String(repRow.user_id) !== ownerId || String(repRow.namespace) !== namespaceVal) {
          return jsonResponse(
            {
              error: {
                code: "BAD_REQUEST",
                message: "replaces_memory_id must belong to the same userId and scope as this request",
              },
            },
            400,
            rateHeaders,
          );
        }
        if (repRow.duplicate_of != null) {
          return jsonResponse(
            { error: { code: "BAD_REQUEST", message: "Target memory was already superseded" } },
            400,
            rateHeaders,
          );
        }
      }

      const metadataOut: Record<string, unknown> = { ...(metadata ?? {}) };
      if (replaces_memory_id) {
        metadataOut.supersedes = replaces_memory_id;
      }
      const normalizedIncoming = normalizeTextForMemoryKey(text);
      const semanticFingerprint = semanticFingerprintFromText(text);
      const canonicalHash = await sha256Hex(
        `${auth.workspaceId}:${ownerId}:${namespaceVal}:${memory_type ?? "note"}:${normalizedIncoming}`,
      );
      const sourceWeight = deriveSourceWeight(metadataOut);
      const strictAutosaveMode = metadata?.autosave_mode === "strict";
      const attachmentType = typeof metadata?.attachment_type === "string" ? metadata.attachment_type.toLowerCase() : null;
      if (attachmentType && BANNED_ATTACHMENT_TYPES.has(attachmentType)) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: `attachment_type '${attachmentType}' is not supported (text and office documents only; no images or video).`,
            },
          },
          400,
          rateHeaders,
        );
      }
      if (attachmentType && !ALLOWED_ATTACHMENT_TYPES.has(attachmentType)) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: `Unsupported attachment_type '${attachmentType}'` } },
          400,
          rateHeaders,
        );
      }
      const attachmentBytes = typeof metadata?.attachment_bytes === "number" ? metadata.attachment_bytes : null;
      if (attachmentBytes != null && attachmentBytes > MAX_ATTACHMENT_BYTES) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: `attachment_bytes exceeds ${MAX_ATTACHMENT_BYTES}` } },
          400,
          rateHeaders,
        );
      }

      if (strictAutosaveMode && !shouldAutoSaveMemory({ text, memoryType: memory_type, metadata })) {
        logger.info({
          event: "memory_save_skipped_low_signal",
          request_id: requestId,
          workspace_id: auth.workspaceId,
          owner_id: ownerId,
          namespace: namespaceVal,
        });
        return jsonResponse(
          {
            stored: false,
            reason: "low_signal",
            message: "Memory skipped by autosave policy.",
          },
          200,
          rateHeaders,
        );
      }

      const dedupeCutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const abuse = await evaluateIngestAbuse(supabase, {
        workspaceId: auth.workspaceId,
        userId: ownerId,
        namespace: namespaceVal,
        canonicalHash,
        semanticFingerprint,
        idempotencyKey: idempotency_key,
        textLength: text.length,
      });
      try {
        await writeIngestControlEvent(supabase, {
          workspaceId: auth.workspaceId,
          userId: ownerId,
          namespace: namespaceVal,
          canonicalHash,
          semanticFingerprint,
          idempotencyKey: idempotency_key,
          textLength: text.length,
          decision: abuse.decision,
          eventType: "ingest_precheck",
          metadata: { reason: abuse.reason ?? null },
        });
      } catch {
        // Best-effort telemetry; ingest should not fail if telemetry table is unavailable.
      }
      if (abuse.decision === "reject") {
        if (abuse.reason === "idempotency_replay" && abuse.existingMemoryId) {
          return jsonResponse(
            { memory_id: abuse.existingMemoryId, stored: true, deduped: true, reason: abuse.reason },
            200,
            rateHeaders,
          );
        }
        return jsonResponse(
          { error: { code: "INGEST_REJECTED", message: abuse.reason ?? "Ingest rejected by abuse controls." } },
          429,
          rateHeaders,
        );
      }
      if (abuse.decision === "throttle") {
        return jsonResponse(
          { error: { code: "INGEST_THROTTLED", message: abuse.reason ?? "Ingest throttled due to abnormal pattern." } },
          429,
          rateHeaders,
        );
      }

      try {
        const byHash = await supabase
          .from("memories")
          .select("id,created_at")
          .eq("workspace_id", auth.workspaceId)
          .eq("user_id", ownerId)
          .eq("namespace", namespaceVal)
          .eq("canonical_hash", canonicalHash)
          .is("duplicate_of", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!byHash.error && byHash.data?.id) {
          return jsonResponse(
            {
              memory_id: byHash.data.id,
              stored: true,
              deduped: true,
              duplicate_created_at: byHash.data.created_at ?? null,
            },
            200,
            rateHeaders,
          );
        }
        const nearMatch = await supabase
          .from("memories")
          .select("id,created_at")
          .eq("workspace_id", auth.workspaceId)
          .eq("user_id", ownerId)
          .eq("namespace", namespaceVal)
          .eq("semantic_fingerprint", semanticFingerprint)
          .is("duplicate_of", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!nearMatch.error && nearMatch.data?.id) {
          return jsonResponse(
            {
              memory_id: nearMatch.data.id,
              stored: true,
              deduped: true,
              duplicate_created_at: nearMatch.data.created_at ?? null,
              dedupe_kind: "near",
            },
            200,
            rateHeaders,
          );
        }
        const rowsResult = await supabase
          .from("memories")
          .select("id,text,created_at")
          .eq("workspace_id", auth.workspaceId)
          .eq("user_id", ownerId)
          .eq("namespace", namespaceVal)
          .gte("created_at", dedupeCutoffIso)
          .order("created_at", { ascending: false })
          .limit(30);
        const dedupeRows = Array.isArray(rowsResult.data) ? rowsResult.data : [];
        if (!rowsResult.error) {
          const duplicate = dedupeRows.find((row) => normalizeTextKey(String(row.text ?? "")) === normalizedIncoming);
          if (duplicate) {
            return jsonResponse(
              {
                memory_id: duplicate.id,
                stored: true,
                deduped: true,
                duplicate_created_at: duplicate.created_at ?? null,
              },
              200,
              rateHeaders,
            );
          }
        }
      } catch {
        // Dedupe is best-effort; continue with normal ingest.
      }

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

      const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toLowerCase();
      const enforceDegradedBlocks = stage === "production" || stage === "prod" || stage === "staging";
      const planCode = String((quota as { effectivePlan?: string }).effectivePlan ?? "launch").toLowerCase();
      let recentNormalizedTexts: string[] = [];
      try {
        const recentNoveltyRows = await supabase
          .from("memories")
          .select("text")
          .eq("workspace_id", auth.workspaceId)
          .eq("user_id", ownerId)
          .eq("namespace", namespaceVal)
          .order("created_at", { ascending: false })
          .limit(20);
        recentNormalizedTexts = Array.isArray(recentNoveltyRows.data)
          ? recentNoveltyRows.data.map((r) => normalizeTextForMemoryKey(String((r as { text?: unknown }).text ?? "")))
          : [];
      } catch {
        recentNormalizedTexts = [];
      }
      const noveltyScore = estimateNoveltyScore(text, recentNormalizedTexts);
      const intelligence = computeIntelligenceScore({
        text,
        memoryType: memory_type ?? "note",
        importance,
        sourceWeight,
        noveltyScore,
      });
      const effectiveImportance = importance ?? Math.max(0.2, 0.8 + intelligence.priorityScore * 1.4);
      if (intelligence.shouldAutoPin) {
        metadataOut.pinned = true;
      }

      const extractionPolicy = await decideExtraction({
        extractRequested: extract,
        text,
        metadata: metadataOut as Record<string, string | number | boolean | null>,
        memory_type: memory_type ?? undefined,
        planCode,
        planLimits: quota.planLimits,
        degradedEntitlements: Boolean(quota.degradedEntitlements),
        enforceDegradedBlocks,
        supabase,
        env,
        requestId,
      });

      const maxExtractReserve = extractionPolicy.maxExtractItems;
      const willAttemptExtraction = maxExtractReserve > 0;

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
        const chunks = d.chunkText(text, chunk_profile);
        const chunkCount = chunks.length;
        const estimatedEmbedTokens = chunks.reduce((sum, ch) => sum + d.estimateEmbedTokens(ch.length), 0);

        const today = d.todayUtc();
        const extractWrites = willAttemptExtraction ? maxExtractReserve : 0;
        const extractEmbeds = willAttemptExtraction ? maxExtractReserve * MAX_CHUNKS_PER_EXTRACTED_ITEM : 0;
        const extractEmbedTokens = willAttemptExtraction ? extractEmbeds * TOKENS_PER_EMBED : 0;
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
            extractionCallsDelta: willAttemptExtraction ? 1 : 0,
          },
          concurrencyHeaders,
          env,
          jsonResponse,
          { route: "/v1/memories", requestId },
        );
        if (reserveResult.response) return reserveResult.response;
        const reservationId = reserveResult.reservationId;

        let budgetTextOnlyIngest = false;
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
            budgetTextOnlyIngest = true;
          } else {
            throw e;
          }
        }

        if (budgetTextOnlyIngest) {
          const reserveMinimal = await d.reserveQuotaAndMaybeRespond(
            quota,
            supabase,
            auth.workspaceId,
            today,
            {
              writesDelta: 1,
              readsDelta: 0,
              embedsDelta: 0,
              embedTokensDelta: 0,
              extractionCallsDelta: 0,
            },
            concurrencyHeaders,
            env,
            jsonResponse,
            { route: "/v1/memories", requestId },
          );
          if (reserveMinimal.response) return reserveMinimal.response;
          const textOnlyReservationId = reserveMinimal.reservationId;

          const { data: memRow, error: memErr } = await supabase
            .from("memories")
            .insert({
              workspace_id: auth.workspaceId,
              user_id: ownerId,
              owner_id: ownerId,
              owner_type: ownerType,
              namespace: namespaceVal,
              text,
              metadata: metadataOut,
              effective_at: effectiveAtIso,
              ...(memory_type ? { memory_type } : {}),
              importance: effectiveImportance,
              canonical_hash: canonicalHash,
              semantic_fingerprint: semanticFingerprint,
              confidence: intelligence.confidence,
              source_weight: intelligence.sourceWeight,
              priority_score: intelligence.priorityScore,
              priority_tier: intelligence.priorityTier,
              pinned_auto: intelligence.shouldAutoPin,
              conflict_state: "none",
            })
            .select("id")
            .single();

          if (memErr || !memRow) {
            if (textOnlyReservationId) {
              await d.markUsageReservationRefundPending(
                supabase,
                textOnlyReservationId,
                memErr?.message ?? "memory_insert_failed_text_only",
              );
            }
            return jsonResponse(
              {
                error: {
                  code: "DB_ERROR",
                  message: memErr?.message ?? "Failed to insert memory",
                },
              },
              500,
              concurrencyHeaders,
            );
          }

          const textOnlyMemoryId = memRow.id as string;

          if (replaces_memory_id) {
            await supabase
              .from("memories")
              .update({ duplicate_of: textOnlyMemoryId })
              .eq("id", replaces_memory_id)
              .eq("workspace_id", auth.workspaceId)
              .eq("user_id", ownerId)
              .eq("namespace", namespaceVal)
              .is("duplicate_of", null);
          }

          try {
            await createMemoryRevision(supabase, {
              workspaceId: auth.workspaceId,
              memoryId: textOnlyMemoryId,
              text,
              metadata: metadataOut,
              reason: "ingest_create",
              source: "api",
            });
          } catch {
            // Backward compatible path when revision table is not present.
          }
          let textOnlyConflict = { hasConflict: false };
          try {
            textOnlyConflict = await detectAndResolveConflict(supabase, {
              workspaceId: auth.workspaceId,
              userId: ownerId,
              namespace: namespaceVal,
              newMemoryId: textOnlyMemoryId,
              newText: text,
              memoryType: memory_type ?? "note",
              confidence: intelligence.confidence,
              sourceWeight: intelligence.sourceWeight,
            });
          } catch {
            textOnlyConflict = { hasConflict: false };
          }
          void updateProfileSnapshot(supabase, {
            workspaceId: auth.workspaceId,
            containerTag: namespaceVal,
            userId: ownerId,
          }).catch(() => {});

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
            {
              body_bytes: Number(request.headers.get("content-length") ?? "0") || undefined,
              chunk_profile: chunk_profile ?? null,
              text_only_ingest: true,
            },
            true,
          );

          logger.info({
            event: "memory_text_only_ingest",
            request_id: requestId,
            memory_id: textOnlyMemoryId,
            reason: "global_ai_budget",
          });

          const textOnlyBody: Record<string, unknown> = {
            memory_id: textOnlyMemoryId,
            stored: true,
            embedding: "skipped_due_to_budget",
            extraction: { status: "skipped", reason: "budget_limit" },
            intelligence: {
              canonical_hash: canonicalHash,
              confidence: intelligence.confidence,
              source_weight: intelligence.sourceWeight,
              priority_score: intelligence.priorityScore,
              priority_tier: intelligence.priorityTier,
              auto_pinned: intelligence.shouldAutoPin,
              conflict_state: textOnlyConflict.hasConflict ? "resolved" : "none",
            },
            ...(replaces_memory_id ? { superseded_memory_id: replaces_memory_id } : {}),
          };

          const piiScanOnBudget = (request.headers.get("x-safety-pii-scan") ?? "").trim() === "1";
          if (piiScanOnBudget) {
            const pii_hints_budget = detectPiiHints(text);
            if (pii_hints_budget.length > 0) {
              textOnlyBody.safety = { pii_hints: pii_hints_budget };
            }
          }

          if (textOnlyReservationId) {
            await d.markUsageReservationCommitted(supabase, textOnlyReservationId);
          }

          return jsonResponse(textOnlyBody, 200, {
            ...concurrencyHeaders,
            "x-extraction-status": "skipped",
            "x-extraction-reason": "budget_limit",
          });
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
        const internalCredits = computeInternalCredits({ embed_tokens: tokenDelta });
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
            p_estimated_cost_inr: estimateEmbedTokenCostInr(tokenDelta, env),
            p_billable: true,
            p_metadata: {
              internal_credits_model: "v1",
              internal_credits_total: internalCredits.total,
              internal_credits: internalCredits.breakdown,
              reconcile: "embed_token_overage",
            },
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
          user_id: ownerId,
          owner_id: ownerId,
          owner_type: ownerType,
          namespace: namespaceVal,
          text,
          metadata: metadataOut,
          effective_at: effectiveAtIso,
          ...(memory_type ? { memory_type } : {}),
          importance: effectiveImportance,
          canonical_hash: canonicalHash,
          semantic_fingerprint: semanticFingerprint,
          confidence: intelligence.confidence,
          source_weight: intelligence.sourceWeight,
          priority_score: intelligence.priorityScore,
          priority_tier: intelligence.priorityTier,
          pinned_auto: intelligence.shouldAutoPin,
          conflict_state: "none",
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
        user_id: ownerId,
        owner_id: ownerId,
        owner_type: ownerType,
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

        if (replaces_memory_id) {
          await supabase
            .from("memories")
            .update({ duplicate_of: memoryId })
            .eq("id", replaces_memory_id)
            .eq("workspace_id", auth.workspaceId)
            .eq("user_id", ownerId)
            .eq("namespace", namespaceVal)
            .is("duplicate_of", null);
        }

        try {
          await createMemoryRevision(supabase, {
            workspaceId: auth.workspaceId,
            memoryId,
            text,
            metadata: metadataOut,
            reason: replaces_memory_id ? "ingest_replaces_memory" : "ingest_create",
            source: "api",
          });
        } catch {
          // Backward compatible path when revision table is not present.
        }
        let conflictOutcome = { hasConflict: false };
        try {
          conflictOutcome = await detectAndResolveConflict(supabase, {
            workspaceId: auth.workspaceId,
            userId: ownerId,
            namespace: namespaceVal,
            newMemoryId: memoryId,
            newText: text,
            memoryType: memory_type ?? "note",
            confidence: intelligence.confidence,
            sourceWeight: intelligence.sourceWeight,
          });
        } catch {
          conflictOutcome = { hasConflict: false };
        }
        void updateProfileSnapshot(supabase, {
          workspaceId: auth.workspaceId,
          containerTag: namespaceVal,
          userId: ownerId,
        }).catch(() => {});

        let extractionResult: { children_created: number; skipped: boolean; error?: string } | undefined;
        let extractionFinalStatus: "run" | "degraded" | "skipped" = "skipped";
        let extractionFinalReason: ExtractionSkipReason | "extraction_error" = extractionPolicy.reason;

        if (willAttemptExtraction) {
          try {
            await checkGlobalCostGuard(supabase, env);
          } catch (e) {
            if (e instanceof AIBudgetExceededError) {
              logger.info({
                event: "extraction_skipped",
                request_id: requestId,
                reason: "budget_limit",
                phase: "pre_extract",
              });
              extractionFinalStatus = "skipped";
              extractionFinalReason = "budget_limit";
              extractionResult = { children_created: 0, skipped: true };
            } else {
              throw e;
            }
          }

          if (!extractionResult) {
            extractionResult = await extractAndStore(
              env,
              supabase,
              d,
              memoryId,
              auth.workspaceId,
              ownerId,
              ownerType,
              namespaceVal,
              text,
              maxExtractReserve,
              effectiveAtIso,
            );

            if (extractionResult.error) {
              logger.error({
                event: "extraction_skipped",
                err: extractionResult.error,
                request_id: requestId,
                source_memory_id: memoryId,
              });
              extractionFinalStatus = "skipped";
              extractionFinalReason = "extraction_error";
            } else {
              extractionFinalStatus = extractionPolicy.status;
              extractionFinalReason = extractionPolicy.reason;
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
                final_status: extractionFinalStatus,
              },
            );
          }
        } else {
          extractionFinalStatus = "skipped";
          extractionFinalReason = extractionPolicy.reason;
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
        {
          body_bytes: Number(request.headers.get("content-length") ?? "0") || undefined,
          chunk_profile: chunk_profile ?? null,
        },
        true,
      );

        /* Quota already reserved via reserveQuotaAndMaybeRespond */
        const response: Record<string, unknown> = {
          memory_id: memoryId,
          stored: true,
          chunks: rows.length,
          intelligence: {
            canonical_hash: canonicalHash,
            confidence: intelligence.confidence,
            source_weight: intelligence.sourceWeight,
            priority_score: intelligence.priorityScore,
            priority_tier: intelligence.priorityTier,
            auto_pinned: intelligence.shouldAutoPin,
            conflict_state: conflictOutcome.hasConflict ? "resolved" : "none",
          },
          ...(replaces_memory_id ? { superseded_memory_id: replaces_memory_id } : {}),
        };
        const extractionPayload: Record<string, unknown> = { status: extractionFinalStatus };
        if (extractionFinalStatus === "skipped") {
          extractionPayload.reason = extractionFinalReason;
          if (extractionResult?.error) extractionPayload.error = extractionResult.error;
        }
        response.extraction = extractionPayload;

        const responseHeaders: Record<string, string> = {
          ...concurrencyHeaders,
          "x-extraction-status": extractionFinalStatus,
        };
        if (extractionFinalStatus === "skipped" && extractionFinalReason !== "none") {
          responseHeaders["x-extraction-reason"] = String(extractionFinalReason);
        }

        const piiScanOn = (request.headers.get("x-safety-pii-scan") ?? "").trim() === "1";
        if (piiScanOn) {
          const pii_hints = detectPiiHints(text);
          if (pii_hints.length > 0) {
            response.safety = { pii_hints };
          }
        }

        if (reservationId) {
          await d.markUsageReservationCommitted(supabase, reservationId);
        }
        return jsonResponse(response, 200, responseHeaders);
      } finally {
        await releaseWorkspaceConcurrencySlot(auth.workspaceId, concurrency.leaseToken, env);
      }
    };

  return {
    handleCreateMemory: handleCreateMemoryImpl,
    handleCreateConversation: async (request, env, supabase, auditCtx, requestId = "", deps?) => {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
      const { jsonResponse } = d;
      const parseResult = await parseWithSchema(ConversationInsertSchema, request);
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
        );
      }
      const p = parseResult.data;
      const meta = { ...(p.metadata ?? {}), source: "conversation" };
      const body: Record<string, unknown> = {
        user_id: p.user_id,
        owner_id: p.owner_id,
        owner_type: p.owner_type,
        userId: p.user_id,
        text: p.text,
        memory_type: p.memory_type ?? "note",
        chunk_profile: p.chunk_profile ?? "dense",
        extract: p.extract,
        metadata: meta,
        namespace: p.namespace,
      };
      if (p.containerTag?.trim()) body.containerTag = p.containerTag.trim();
      if (p.scope?.trim()) body.scope = p.scope.trim();
      if (p.entity_id?.trim()) body.entity_id = p.entity_id.trim();
      if (p.entity_type) body.entity_type = p.entity_type;
      if (p.importance !== undefined) body.importance = p.importance;
      if (p.effective_at?.trim()) body.effective_at = p.effective_at.trim();
      if (p.replaces_memory_id) body.replaces_memory_id = p.replaces_memory_id;
      if (p.idempotency_key) body.idempotency_key = p.idempotency_key;
      const memUrl = new URL("/v1/memories", request.url);
      const forwarded = new Request(memUrl.toString(), {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      });
      return handleCreateMemoryImpl(forwarded, env, supabase, auditCtx, requestId, deps);
    },

    async handleListMemories(request, env, supabase, url, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      let keyRateHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
        const rate = await rateLimit(auth.keyHash, env, auth);
        if (!rate.allowed) {
          return jsonResponse(
            { error: { code: "rate_limited", message: "Rate limit exceeded" } },
            429,
            rate.headers,
          );
        }
        keyRateHeaders = rate.headers;
      }
      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quota.blocked) {
        return jsonResponse(
          {
            error: {
              code: quota.errorCode ?? "ENTITLEMENT_REQUIRED",
              message: quota.message ?? "No active paid entitlement found. Start a plan to continue quota-consuming API calls.",
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
      let rateHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
        const wsRpm = quota.planLimits.workspace_rpm ?? 120;
        const wsRate = await rateLimitWorkspace(auth.workspaceId, wsRpm, env);
        if (!wsRate.allowed) {
          return jsonResponse(
            { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
            429,
            { ...keyRateHeaders, ...wsRate.headers },
          );
        }
        rateHeaders = { ...keyRateHeaders, ...wsRate.headers };
      }
      const reserveList = await d.reserveQuotaAndMaybeRespond(
        quota,
        supabase,
        auth.workspaceId,
        d.todayUtc(),
        {
          writesDelta: 0,
          readsDelta: 1,
          embedsDelta: 0,
          embedTokensDelta: 0,
          extractionCallsDelta: 0,
        },
        rateHeaders,
        env,
        jsonResponse,
        { route: "/v1/memories", requestId },
      );
      if (reserveList.response) return reserveList.response;
      const listReservationId = reserveList.reservationId;

      const params = d.normalizeMemoryListParams(url);
      let result: ListOutcome;
      try {
        result = await d.performListMemories(auth, params, supabase);
      } catch (err) {
        if (listReservationId) {
          await d.markUsageReservationRefundPending(
            supabase,
            listReservationId,
            err instanceof Error ? err.message : String(err),
          );
        }
        throw err;
      }
      if (listReservationId) {
        await d.markUsageReservationCommitted(supabase, listReservationId);
      }

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

    async handleGetMemory(request, env, supabase, memoryId, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
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
      let rateHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
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
        rateHeaders = { ...rate.headers, ...wsRate.headers };
      }
      const reserveGet = await d.reserveQuotaAndMaybeRespond(
        quota,
        supabase,
        auth.workspaceId,
        d.todayUtc(),
        {
          writesDelta: 0,
          readsDelta: 1,
          embedsDelta: 0,
          embedTokensDelta: 0,
          extractionCallsDelta: 0,
        },
        rateHeaders,
        env,
        jsonResponse,
        { route: "/v1/memories/:id", requestId },
      );
      if (reserveGet.response) return reserveGet.response;
      const getReservationId = reserveGet.reservationId;

      let data: ListOutcome["results"][number] | null;
      try {
        data = await d.getMemoryByIdScoped(supabase, auth.workspaceId, memoryId);
      } catch (err) {
        if (getReservationId) {
          await d.markUsageReservationRefundPending(
            supabase,
            getReservationId,
            err instanceof Error ? err.message : String(err),
          );
        }
        throw err;
      }
      if (getReservationId) {
        await d.markUsageReservationCommitted(supabase, getReservationId);
      }
      if (!data) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "Memory not found" } }, 404, rateHeaders);
      }

      return jsonResponse(data, 200, rateHeaders);
    },

    async handleDeleteMemory(request, env, supabase, memoryId, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as MemoryHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
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
      let rateHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
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
        rateHeaders = { ...rate.headers, ...wsRate.headers };
      }

      const deleted = await d.deleteMemoryCascade(supabase, auth.workspaceId, memoryId);
      if (!deleted) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "Memory not found" } }, 404, rateHeaders);
      }

      return jsonResponse({ deleted: true, id: memoryId }, 200, rateHeaders);
    },

    async handlePatchProfilePins(request, env, supabase, auditCtx, requestId = "", deps?) {
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
      let rateHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
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
        rateHeaders = { ...rate.headers, ...wsRate.headers };
      }

      const parseResult = await parseWithSchema(ProfilePinsPatchSchema, request);
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
          user_id: parseResult.data.user_id,
          scope: parseResult.data.scope,
          namespace: parseResult.data.namespace,
          containerTag: parseResult.data.containerTag,
        },
        { scopedContainerTag: auth.scopedContainerTag ?? null },
      );
      const rateHeadersWithRouting = { ...rateHeaders, ...isolationResolution.responseHeaders };
      parseResult.data.user_id = isolationResolution.isolation.ownerId;
      parseResult.data.namespace = isolationResolution.isolation.containerTag;

      const userId = parseResult.data.user_id;
      const namespace = parseResult.data.namespace;
      const newIds = [...new Set(parseResult.data.memory_ids)];

      const reserve = await d.reserveQuotaAndMaybeRespond(
        quota,
        supabase,
        auth.workspaceId,
        d.todayUtc(),
        {
          writesDelta: Math.min(24, newIds.length + 12),
          readsDelta: 1 + newIds.length,
          embedsDelta: 0,
          embedTokensDelta: 0,
          extractionCallsDelta: 0,
        },
        rateHeadersWithRouting,
        env,
        jsonResponse,
        { route: "/v1/profile/pins", requestId },
      );
      if (reserve.response) return reserve.response;
      const reservationId = reserve.reservationId;

      try {
        const pinnedList = await d.performListMemories(
          auth,
          {
            page: 1,
            page_size: 100,
            namespace,
            user_id: userId,
            filters: { metadata: { pinned: true } },
          },
          supabase,
        );

        const newSet = new Set(newIds);
        const toUnpin = pinnedList.results.filter((r) => !newSet.has(r.id));
        const errors: string[] = [];

        for (const row of toUnpin) {
          const meta = mergeMetadataPinned(row.metadata, false);
          const { error } = await supabase
            .from("memories")
            .update({ metadata: meta })
            .eq("workspace_id", auth.workspaceId)
            .eq("id", row.id)
            .eq("user_id", userId)
            .eq("namespace", namespace);
          if (error) errors.push(error.message);
        }

        for (const id of newIds) {
          const row = await d.getMemoryByIdScoped(supabase, auth.workspaceId, id);
          if (!row) {
            errors.push(`memory ${id} not found`);
            continue;
          }
          if (row.user_id !== userId || row.namespace !== namespace) {
            errors.push(`memory ${id} not in scope`);
            continue;
          }
          if (row.source_memory_id) {
            errors.push(`memory ${id} is an extracted child row`);
            continue;
          }
          const meta = mergeMetadataPinned(row.metadata, true);
          const { error } = await supabase
            .from("memories")
            .update({ metadata: meta })
            .eq("workspace_id", auth.workspaceId)
            .eq("id", id)
            .eq("user_id", userId)
            .eq("namespace", namespace);
          if (error) errors.push(error.message);
        }

        if (errors.length > 0) {
          if (reservationId) {
            await d.markUsageReservationRefundPending(supabase, reservationId, errors.join("; "));
          }
          return jsonResponse(
            { error: { code: "BAD_REQUEST", message: errors[0] ?? "pin update failed", details: errors } },
            400,
            rateHeadersWithRouting,
          );
        }

        if (reservationId) {
          await d.markUsageReservationCommitted(supabase, reservationId);
        }
        return jsonResponse(
          { ok: true, pinned_memory_ids: newIds, unpinned: toUnpin.map((r) => r.id) },
          200,
          rateHeadersWithRouting,
        );
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
    },
  };
}
