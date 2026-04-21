import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpActionId } from "@memorynodeai/shared";
import { z } from "zod";
import type { HostedBrandedDeps } from "../../adapters/hosted.js";
import { formatDeniedForTool, toolError } from "../../hosted/policyResponses.js";
import { trialExpiredWriteToolResult } from "../../hosted/trialWriteGate.js";

export const MEMORY_GET_DESCRIPTION = [
  "WHAT: Loads a single memory row by UUID for the authenticated workspace.",
  "WHEN: Call this when you have a memory id (from search, list, or UI) and need full text/metadata.",
  "INSTEAD: Use `memory_list` when you only need browsing or paging without a known id.",
  "RETURNS: Memory fields as JSON from the REST API.",
].join("\n");

export const MEMORY_DELETE_DESCRIPTION = [
  "WHAT: Deletes one memory permanently by UUID (direct delete without semantic match).",
  "WHEN: Call this when you already trust the uuid (for example after list/search) and want immediate removal.",
  "INSTEAD: Use `memory_forget` when you only have natural-language text and need semantic lookup first.",
  "RETURNS: Confirmation payload including `memory_id`.",
].join("\n");

export const MEMORY_LIST_DESCRIPTION = [
  "WHAT: Lists memories for the current scope with pagination and optional filters.",
  "WHEN: Call this to browse recent rows, audit content, or pick ids before delete/get.",
  "INSTEAD: Use `search` when you need relevance-ranked chunks across the corpus.",
  "RETURNS: Paginated results array plus total/has_more per REST contract.",
].join("\n");

export const MEMORY_CONVERSATION_SAVE_DESCRIPTION = [
  "WHAT: Stores a conversation transcript or structured messages as memory (same pipeline as the conversation REST route).",
  "WHEN: Call this after multi-turn chats or imports where one POST should persist the whole thread.",
  "INSTEAD: Use `memory_save` for a single atomic fact without full transcript payload.",
  "RETURNS: Created memory summary from the API response.",
].join("\n");

export const INGEST_DISPATCH_DESCRIPTION = [
  "WHAT: Dispatches the unified ingest endpoint (memory, conversation, document, or bundle import).",
  "WHEN: Call this when routing ingestion by kind rather than calling each REST route separately.",
  "INSTEAD: Call `memory_save` or `memory_conversation_save` directly when you already know the exact route.",
  "RETURNS: Handler JSON from `/v1/ingest` (shape depends on `kind`).",
].join("\n");

export const EVAL_RUN_DESCRIPTION = [
  "WHAT: Runs an eval set against live search for each item (precision/recall metrics).",
  "WHEN: Call this after eval items exist and you want batch scoring for a set id.",
  "INSTEAD: Use `search` for normal retrieval — eval_run is for measurement only.",
  "RETURNS: Aggregates and per-item metrics from `/v1/evals/run`.",
].join("\n");

export function registerP1HostedTools(server: McpServer, deps: HostedBrandedDeps): void {
  const {
    env,
    restApiOrigin,
    apiKey,
    auth,
    requestId,
    hostedPolicy,
    internalJson,
    MCP_POLICY_VERSION,
    invalidateScopeCache,
    resolveScope,
    toPolicyScope,
    evaluateWithLog,
  } = deps;

  server.registerTool(
    "memory_get",
    {
      description: MEMORY_GET_DESCRIPTION,
      inputSchema: {
        memory_id: z.string().uuid(),
        containerTag: z.string().max(128).optional(),
      },
    },
    async ({ memory_id, containerTag }) => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(containerTag);
      const scope = toPolicyScope({ user_id, namespace });
      const actionId: McpActionId = "memory.read";
      const decision = evaluateWithLog(actionId, {
        scope,
        queryText: memory_id,
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      try {
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "GET",
          `/v1/memories/${encodeURIComponent(memory_id)}`,
          undefined,
          requestId,
        );
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Get failed";
          return toolError("weak_signal", msg);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out.data, null, 2) }],
          structuredContent: {
            status: "ok",
            data: out.data,
            policy_version: MCP_POLICY_VERSION,
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        hostedPolicy.complete({
          actionId,
          scope,
          nowMs: Date.now(),
          queryText: memory_id,
        });
      }
    },
  );

  server.registerTool(
    "memory_list",
    {
      description: MEMORY_LIST_DESCRIPTION,
      inputSchema: {
        containerTag: z.string().max(128).optional(),
        page: z.number().int().min(1).optional().default(1),
        page_size: z.number().int().min(1).max(50).optional().default(20),
        metadata_filter: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      },
    },
    async ({ containerTag, page, page_size, metadata_filter }) => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(containerTag);
      const scope = toPolicyScope({ user_id, namespace });
      const listQueryKey = `${namespace}:${page}:${page_size}:${JSON.stringify(metadata_filter ?? {})}`;
      const actionId: McpActionId = "memory.read";
      const decision = evaluateWithLog(actionId, {
        scope,
        queryText: listQueryKey.slice(0, 2000),
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      try {
        const params = new URLSearchParams({
          user_id,
          namespace,
          page: String(page),
          page_size: String(page_size),
        });
        if (metadata_filter && Object.keys(metadata_filter).length > 0) {
          params.set("metadata", JSON.stringify(metadata_filter));
        }
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "GET",
          `/v1/memories?${params.toString()}`,
          undefined,
          requestId,
        );
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "List failed";
          return toolError("weak_signal", msg);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out.data, null, 2) }],
          structuredContent: {
            status: "ok",
            data: out.data,
            policy_version: MCP_POLICY_VERSION,
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        hostedPolicy.complete({
          actionId,
          scope,
          nowMs: Date.now(),
          queryText: listQueryKey.slice(0, 2000),
        });
      }
    },
  );

  server.registerTool(
    "memory_delete",
    {
      description: MEMORY_DELETE_DESCRIPTION,
      inputSchema: {
        memory_id: z.string().uuid(),
        containerTag: z.string().max(128).optional(),
        nonce: z.string().min(8).optional(),
        timestampMs: z.number().int().optional(),
      },
    },
    async ({ memory_id, containerTag, nonce, timestampMs }) => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(containerTag);
      const scope = toPolicyScope({ user_id, namespace });
      const actionId: McpActionId = "memory.delete";
      const decision = evaluateWithLog(actionId, {
        scope,
        contentText: memory_id,
        nonce,
        timestampMs,
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      const mustComplete = decision.status === "allow" || decision.status === "degrade";
      try {
        const trialBlock = trialExpiredWriteToolResult(deps);
        if (trialBlock) return trialBlock;
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "DELETE",
          `/v1/memories/${encodeURIComponent(memory_id)}`,
          undefined,
          requestId,
        );
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Delete failed";
          return toolError("confirmation_required", msg);
        }
        invalidateScopeCache(auth.workspaceId, user_id, namespace);
        return {
          content: [{ type: "text" as const, text: `Deleted memory ${memory_id}.` }],
          structuredContent: {
            status: "deleted",
            data: { memory_id, policy_version: MCP_POLICY_VERSION },
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        if (mustComplete) {
          hostedPolicy.complete({
            actionId,
            scope,
            nowMs: Date.now(),
            contentText: memory_id,
            nonce,
            timestampMs,
          });
        }
      }
    },
  );

  server.registerTool(
    "memory_conversation_save",
    {
      description: MEMORY_CONVERSATION_SAVE_DESCRIPTION,
      inputSchema: {
        body: z.record(z.unknown()).describe("JSON body matching POST /v1/memories/conversation (messages, transcript, namespace, etc.)."),
        containerTag: z.string().max(128).optional(),
        nonce: z.string().min(8).optional(),
        timestampMs: z.number().int().optional(),
      },
    },
    async ({ body, containerTag, nonce, timestampMs }) => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(containerTag);
      const scope = toPolicyScope({ user_id, namespace });
      const merged: Record<string, unknown> = { ...body };
      if (typeof merged.namespace !== "string" || String(merged.namespace).trim().length === 0) {
        merged.namespace = namespace;
      }
      if (typeof merged.user_id !== "string" || String(merged.user_id).trim().length === 0) {
        merged.user_id = user_id;
      }
      const payloadText = JSON.stringify(merged);
      const actionId: McpActionId = "memory.conversation_save";
      const decision = evaluateWithLog(actionId, {
        scope,
        contentText: payloadText,
        nonce,
        timestampMs,
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      const mustComplete = decision.status === "allow" || decision.status === "degrade";
      try {
        const trialBlock = trialExpiredWriteToolResult(deps);
        if (trialBlock) return trialBlock;
        const out = await internalJson(env, restApiOrigin, apiKey, "POST", "/v1/memories/conversation", merged as Record<string, unknown>, requestId);
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Conversation save failed";
          return toolError("weak_signal", msg);
        }
        invalidateScopeCache(auth.workspaceId, user_id, namespace);
        return {
          content: [{ type: "text" as const, text: "Conversation saved to MemoryNode." }],
          structuredContent: {
            status: "saved",
            data: out.data,
            policy_version: MCP_POLICY_VERSION,
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        if (mustComplete) {
          hostedPolicy.complete({
            actionId,
            scope,
            nowMs: Date.now(),
            contentText: payloadText,
            nonce,
            timestampMs,
          });
        }
      }
    },
  );

  const ingestUnion = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("memory"), body: z.record(z.unknown()) }),
    z.object({ kind: z.literal("conversation"), body: z.record(z.unknown()) }),
    z.object({ kind: z.literal("document"), body: z.record(z.unknown()) }),
    z.object({ kind: z.literal("bundle"), body: z.record(z.unknown()) }),
  ]);

  server.registerTool(
    "ingest_dispatch",
    {
      description: INGEST_DISPATCH_DESCRIPTION,
      inputSchema: {
        payload: ingestUnion,
        nonce: z.string().min(8).optional(),
        timestampMs: z.number().int().optional(),
      },
    },
    async ({ payload, nonce, timestampMs }) => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const payloadText = JSON.stringify(payload);
      const actionId: McpActionId = "ingest.dispatch";
      const decision = evaluateWithLog(actionId, {
        scope,
        contentText: payloadText,
        nonce,
        timestampMs,
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      const mustComplete = decision.status === "allow" || decision.status === "degrade";
      try {
        const trialBlock = trialExpiredWriteToolResult(deps);
        if (trialBlock) return trialBlock;
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "POST",
          "/v1/ingest",
          payload as unknown as Record<string, unknown>,
          requestId,
        );
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Ingest failed";
          return toolError("weak_signal", msg);
        }
        invalidateScopeCache(auth.workspaceId, user_id, namespace);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out.data, null, 2) }],
          structuredContent: {
            status: "ok",
            data: out.data,
            policy_version: MCP_POLICY_VERSION,
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        if (mustComplete) {
          hostedPolicy.complete({
            actionId,
            scope,
            nowMs: Date.now(),
            contentText: payloadText,
            nonce,
            timestampMs,
          });
        }
      }
    },
  );

  server.registerTool(
    "eval_run",
    {
      description: EVAL_RUN_DESCRIPTION,
      inputSchema: {
        eval_set_id: z.string().uuid(),
        user_id: z.string().min(1).optional(),
        owner_id: z.string().min(1).optional(),
        entity_id: z.string().min(1).optional(),
        namespace: z.string().optional(),
        top_k: z.number().int().min(1).max(50).optional(),
        search_mode: z.enum(["hybrid", "vector", "keyword"]).optional(),
        min_score: z.number().min(0).max(1).optional(),
        nonce: z.string().min(8).optional(),
        timestampMs: z.number().int().optional(),
      },
    },
    async (args) => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const body: Record<string, unknown> = {
        eval_set_id: args.eval_set_id,
        namespace: args.namespace ?? namespace,
      };
      const uid = args.user_id ?? args.owner_id ?? args.entity_id ?? user_id;
      body.user_id = uid;
      body.owner_id = uid;
      if (args.top_k !== undefined) body.top_k = args.top_k;
      if (args.search_mode !== undefined) body.search_mode = args.search_mode;
      if (args.min_score !== undefined) body.min_score = args.min_score;
      const payloadText = JSON.stringify(body);
      const actionId: McpActionId = "eval.run";
      const decision = evaluateWithLog(actionId, {
        scope,
        contentText: payloadText,
        nonce: args.nonce,
        timestampMs: args.timestampMs,
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      const mustComplete = decision.status === "allow" || decision.status === "degrade";
      try {
        const out = await internalJson(env, restApiOrigin, apiKey, "POST", "/v1/evals/run", body, requestId);
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Eval run failed";
          return toolError("cost_exceeded", msg);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out.data, null, 2) }],
          structuredContent: {
            status: "ok",
            data: out.data,
            policy_version: MCP_POLICY_VERSION,
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        if (mustComplete) {
          hostedPolicy.complete({
            actionId,
            scope,
            nowMs: Date.now(),
            contentText: payloadText,
            nonce: args.nonce,
            timestampMs: args.timestampMs,
          });
        }
      }
    },
  );
}
