/**
 * Memory CRUD handlers. Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * All dependencies injected via MemoryHandlerDeps to avoid circular dependency with index.
 *
 * Phase 6 additions:
 * - memory_type column support on insert
 * - Optional lightweight extraction (extract: true) that creates child memories
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import { MemoryInsertSchema, parseWithSchema } from "../contracts/index.js";
import type { MemoryType } from "../contracts/index.js";

export type { MemoryInsertPayload } from "../contracts/index.js";

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
  embedText: (texts: string[], env: Env) => Promise<number[][]>;
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
 * Returns empty array on any failure (fail-silent contract).
 */
const MAX_EXTRACT_ITEMS = 10;
const EXTRACT_TIMEOUT_MS = 15_000;

async function extractItems(text: string, env: Env): Promise<ExtractedItem[]> {
  if (!env.OPENAI_API_KEY) return [];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
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
    if (!resp.ok) return [];
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
        // "note" excluded: notes are user-authored, not auto-extracted
        ["fact", "preference", "event"].includes(item.memory_type)
      ) {
        valid.push({ text: item.text, memory_type: item.memory_type as MemoryType });
      }
      if (valid.length >= MAX_EXTRACT_ITEMS) break;
    }
    return valid;
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Extract items from source text and store as child memories.
 * Returns counts for observability. Failures are logged and emitted as product events.
 * Child writes and embeds are accounted against usage.
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
  let totalEmbeds = 0;
  try {
    const items = await extractItems(text, env);
    if (items.length === 0) return { children_created: 0, skipped: false };

    for (const item of items) {
      const chunks = d.chunkText(item.text);
      const embeddings = await d.embedText(chunks, env);
      totalEmbeds += chunks.length;

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
  } finally {
    if (totalWrites > 0 || totalEmbeds > 0) {
      try {
        await d.bumpUsage(supabase, workspaceId, d.todayUtc(), {
          writesDelta: totalWrites,
          readsDelta: 0,
          embedsDelta: totalEmbeds,
        });
      } catch {
        /* best-effort usage accounting */
      }
    }
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
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
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
          rate.headers,
        );
      }

      const { user_id, text, metadata, namespace, memory_type, extract } = parseResult.data;
      const namespaceVal = namespace ?? DEFAULT_NAMESPACE;

      const chunks = d.chunkText(text);
      const chunkCount = chunks.length;

      const capResponse = await d.checkCapsAndMaybeRespond(
        jsonResponse,
        auth,
        supabase,
        { writesDelta: 1, readsDelta: 0, embedsDelta: chunkCount },
        rate.headers,
        env,
        { requestId, route: "/v1/memories", method: "POST" },
      );
      if (capResponse) return capResponse;

      const today = d.todayUtc();
      const embeddings = await d.embedText(chunks, env);

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
        return jsonResponse(
          {
            error: {
              code: "DB_ERROR",
              message: memoryError?.message ?? "Failed to insert memory",
            },
          },
          500,
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
        return jsonResponse(
          { error: { code: "DB_ERROR", message: chunkError.message ?? "Failed to insert chunks" } },
          500,
          rate.headers,
        );
      }

      let extractionResult: { children_created: number; skipped: boolean; error?: string } | undefined;
      if (extract) {
        extractionResult = await extractAndStore(env, supabase, d, memoryId, auth.workspaceId, user_id, namespaceVal, text);

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

      await d.bumpUsage(supabase, auth.workspaceId, today, {
        writesDelta: 1,
        readsDelta: 0,
        embedsDelta: chunkCount,
      });

      const response: Record<string, unknown> = { memory_id: memoryId, chunks: rows.length };
      if (extractionResult) {
        response.extraction = {
          triggered: true,
          children_created: extractionResult.children_created,
          skipped: extractionResult.skipped,
          ...(extractionResult.error ? { error: extractionResult.error } : {}),
        };
      }

      return jsonResponse(response, 200, rate.headers);
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
        rate.headers,
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
