import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpActionId } from "@memorynodeai/shared";
import { z } from "zod";
import type { HostedBrandedDeps } from "../../adapters/hosted.js";
import { formatDeniedForTool, toolError } from "../../hosted/policyResponses.js";
import { trialExpiredWriteToolResult } from "../../hosted/trialWriteGate.js";
import {
  MIN_DELETE_CONFIDENCE,
  normalizedConfidenceFromFusionScore,
} from "../../hosted/helpers.js";

const MEMORY_SAVE_DESCRIPTION = [
  "WHAT: Persists a piece of information to long-term memory for a specific user or account.",
  "WHEN: Call this after any conversation turn where the user shares a fact, preference, goal, or context worth remembering across future sessions.",
  "INSTEAD: Use `memory_conversation_save` if you have a full conversation transcript to ingest at once rather than a single fact.",
  "RETURNS: The saved memory object including its assigned UUID and timestamp.",
].join("\n");

const MEMORY_FORGET_DESCRIPTION = [
  "WHAT: Finds and removes a memory by semantic search rather than by ID.",
  "WHEN: Call this when a user says they want the AI to forget something and you do not have the memory UUID.",
  "INSTEAD: Use `memory_delete` if you already have the memory UUID — it is faster and more precise.",
  "RETURNS: A confirmation token required to complete deletion via `memory_forget_confirm` when the match is ambiguous; otherwise it deletes immediately.",
].join("\n");

const MEMORY_FORGET_CONFIRM_DESCRIPTION = [
  "WHAT: Completes a staged forget after `memory_forget` returned a confirmation token or when you already know the exact `memory_id`.",
  "WHEN: Call this after the user confirms deletion or when you must delete a specific row by id.",
  "INSTEAD: Use `memory_forget` when you only have natural-language text and need semantic lookup first.",
  "RETURNS: Confirmation that the memory row was deleted and the affected `memory_id`.",
].join("\n");

const sharedMemoryInputSchema = {
  content: z.string().min(1).max(10_000).optional().describe("Memory text to save, or text to match when forgetting."),
  action: z
    .enum(["save", "forget", "confirm_forget"])
    .optional()
    .describe('Default "save". Use "forget" to stage deletion or "confirm_forget" to confirm deletion.'),
  containerTag: z.string().max(128).optional().describe("Optional scope tag; maps to MemoryNode namespace."),
  confirm: z
    .object({
      token: z.string().optional(),
      memory_id: z.string().optional(),
    })
    .optional()
    .describe("Used by confirm_forget action."),
  nonce: z.string().min(8).optional().describe("Replay-protection nonce for mutating actions."),
  timestampMs: z.number().int().optional().describe("Replay-protection timestamp in epoch milliseconds."),
};

export function registerMemoryFamily(server: McpServer, deps: HostedBrandedDeps): void {
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
    logger,
  } = deps;

  server.registerTool(
    "memory",
    {
      description: "Save or forget persistent memory for this workspace (MemoryNode).",
      inputSchema: sharedMemoryInputSchema,
    },
    async ({ content, action, containerTag, confirm, nonce, timestampMs }) => {
      const execStart = Date.now();
      const act = action ?? "save";
      const { user_id, namespace } = resolveScope(containerTag);
      const scope = toPolicyScope({ user_id, namespace });
      const actionId: McpActionId =
        act === "forget" ? "memory.forget" : act === "confirm_forget" ? "memory.confirm_forget" : "memory.save";
      const decision = evaluateWithLog(actionId, {
        scope,
        contentText: content,
        nonce,
        timestampMs,
      });
      if (decision.status === "deny") {
        return formatDeniedForTool(actionId, scope, decision);
      }
      const mustComplete = decision.status === "allow" || decision.status === "degrade";
      try {
        if (act === "confirm_forget") {
          const trialBlock = trialExpiredWriteToolResult(deps);
          if (trialBlock) return trialBlock;
          const token = confirm?.token ?? "";
          const memoryId = confirm?.memory_id ?? "";
          if (!token && !memoryId) {
            return toolError("confirmation_required", "confirm_forget requires token or memory_id.");
          }
          if (token) {
            const tokenDecision = hostedPolicy.consumeConfirmationToken(
              {
                actionId,
                scope,
                nowMs: Date.now(),
              },
              token,
              memoryId || undefined,
            );
            if (tokenDecision.status === "deny") {
              return formatDeniedForTool(actionId, scope, tokenDecision);
            }
          }
          const targetId = memoryId || confirm?.memory_id;
          if (!targetId) {
            return toolError("confirmation_required", "No memory_id available for confirm_forget.");
          }
          const del = await internalJson(
            env,
            restApiOrigin,
            apiKey,
            "DELETE",
            `/v1/memories/${encodeURIComponent(targetId)}`,
            undefined,
            requestId,
          );
          if (!del.ok) {
            const msg =
              typeof (del.data as { error?: { message?: string } })?.error?.message === "string"
                ? (del.data as { error: { message: string } }).error.message
                : "Delete failed";
            return toolError("confirmation_required", `Delete failed: ${msg}`);
          }
          invalidateScopeCache(auth.workspaceId, user_id, namespace);
          return {
            content: [{ type: "text" as const, text: `Forgot memory ${targetId}.` }],
            structuredContent: {
              status: "forgot",
              decision: { code: "OK", message: "confirmed_delete" },
              data: { memory_id: targetId, policy_version: MCP_POLICY_VERSION },
            },
          };
        }
        if (act === "save") {
          const trialBlock = trialExpiredWriteToolResult(deps);
          if (trialBlock) return trialBlock;
          logger.info({
            event: "mcp_tool",
            tool: "memory",
            action: "save",
            userId: user_id,
            project: namespace,
            workspace_id: auth.workspaceId,
            request_id: requestId,
            policy_version: MCP_POLICY_VERSION,
            decision_id: decision.decisionId,
          });
          if (!content || !content.trim()) {
            return toolError("weak_signal", "content is required for save action.");
          }
          const out = await internalJson(
            env,
            restApiOrigin,
            apiKey,
            "POST",
            "/v1/memories",
            { user_id, namespace, text: content },
            requestId,
          );
          if (!out.ok) {
            const msg =
              typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
                ? (out.data as { error: { message: string } }).error.message
                : "Insert failed";
            return toolError("weak_signal", `Insert failed: ${msg}`);
          }
          invalidateScopeCache(auth.workspaceId, user_id, namespace);
          return {
            content: [{ type: "text" as const, text: "Saved to MemoryNode." }],
            structuredContent: {
              status: "saved",
              decision: { code: "OK", message: "saved" },
              data: { deduped: false, policy_version: MCP_POLICY_VERSION },
            },
          };
        }
        logger.info({
          event: "mcp_tool",
          tool: "memory",
          action: "forget",
          userId: user_id,
          project: namespace,
          workspace_id: auth.workspaceId,
          request_id: requestId,
          policy_version: MCP_POLICY_VERSION,
          decision_id: decision.decisionId,
        });
        if (!content || !content.trim()) {
          return toolError("weak_signal", "content is required for forget action.");
        }
        const search = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "POST",
          "/v1/search",
          { user_id, namespace, query: content.slice(0, 2000), top_k: 3 },
          requestId,
        );
        if (!search.ok) {
          return toolError("cost_exceeded", "Search failed while trying to forget.");
        }
        const results = Array.isArray((search.data as { results?: unknown })?.results)
          ? (search.data as {
              results: Array<{ memory_id?: string; id?: string; score?: number }>;
            }).results
          : [];
        const top = results[0];
        const memoryId =
          typeof top?.memory_id === "string"
            ? top.memory_id
            : typeof (top as { id?: string } | undefined)?.id === "string"
              ? (top as { id: string }).id
              : null;
        const rawScore = typeof top?.score === "number" ? top.score : NaN;
        const confidence = normalizedConfidenceFromFusionScore(rawScore);

        if (!memoryId) {
          return {
            content: [{ type: "text" as const, text: "No match found." }],
            structuredContent: {
              status: "rejected",
              decision: { code: "NO_MATCH", message: "No match found." },
              data: { policy_version: MCP_POLICY_VERSION },
            },
          };
        }
        const second = results[1];
        const secondScore = typeof second?.score === "number" ? second.score : 0;
        const scoreGap = rawScore - secondScore;
        if (confidence < MIN_DELETE_CONFIDENCE || scoreGap < 0.12) {
          const token = hostedPolicy.issueConfirmationToken(
            {
              actionId,
              scope,
              nowMs: Date.now(),
            },
            memoryId,
          );
          const candidates = results.slice(0, 3).map((row) => ({
            memory_id:
              typeof row.memory_id === "string"
                ? row.memory_id
                : typeof row.id === "string"
                  ? row.id
                  : "",
            score: typeof row.score === "number" ? row.score : 0,
          }));
          return {
            content: [
              {
                type: "text" as const,
                text: "Ambiguous forget request. Confirmation required.",
              },
            ],
            structuredContent: {
              status: "needs_confirmation",
              decision: { code: "NEEDS_CONFIRMATION", message: "Confirmation required before deleting memory." },
              data: {
                confirmation_token: token.token,
                expires_at: new Date(token.expiresAt).toISOString(),
                candidates,
                policy_version: MCP_POLICY_VERSION,
              },
            },
          };
        }

        const trialForget = trialExpiredWriteToolResult(deps);
        if (trialForget) return trialForget;

        const del = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "DELETE",
          `/v1/memories/${encodeURIComponent(memoryId)}`,
          undefined,
          requestId,
        );
        if (!del.ok) {
          const msg =
            typeof (del.data as { error?: { message?: string } })?.error?.message === "string"
              ? (del.data as { error: { message: string } }).error.message
              : "Delete failed";
          return toolError("confirmation_required", `Delete failed: ${msg}`);
        }
        invalidateScopeCache(auth.workspaceId, user_id, namespace);
        return {
          content: [{ type: "text" as const, text: `Forgot memory ${memoryId}.` }],
          structuredContent: {
            status: "forgot",
            decision: { code: "OK", message: "deleted" },
            data: { memory_id: memoryId, policy_version: MCP_POLICY_VERSION },
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
            contentText: content,
            nonce,
            timestampMs,
          });
        }
      }
    },
  );

  server.registerTool(
    "memory_save",
    {
      description: MEMORY_SAVE_DESCRIPTION,
      inputSchema: {
        content: z.string().min(1).max(10_000).describe("Memory text to save."),
        containerTag: z.string().max(128).optional().describe("Optional scope tag; maps to MemoryNode namespace."),
        nonce: z.string().min(8).optional().describe("Replay-protection nonce for mutating actions."),
        timestampMs: z.number().int().optional().describe("Replay-protection timestamp in epoch milliseconds."),
      },
    },
    async ({ content, containerTag, nonce, timestampMs }) => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(containerTag);
      const scope = toPolicyScope({ user_id, namespace });
      const actionId: McpActionId = "memory.save";
      const decision = evaluateWithLog(actionId, {
        scope,
        contentText: content,
        nonce,
        timestampMs,
      });
      if (decision.status === "deny") {
        return formatDeniedForTool(actionId, scope, decision);
      }
      const mustComplete = decision.status === "allow" || decision.status === "degrade";
      try {
        const trialBlock = trialExpiredWriteToolResult(deps);
        if (trialBlock) return trialBlock;
        logger.info({
          event: "mcp_tool",
          tool: "memory_save",
          action: "save",
          userId: user_id,
          project: namespace,
          workspace_id: auth.workspaceId,
          request_id: requestId,
          policy_version: MCP_POLICY_VERSION,
          decision_id: decision.decisionId,
        });
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "POST",
          "/v1/memories",
          { user_id, namespace, text: content },
          requestId,
        );
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Insert failed";
          return toolError("weak_signal", `Insert failed: ${msg}`);
        }
        invalidateScopeCache(auth.workspaceId, user_id, namespace);
        return {
          content: [{ type: "text" as const, text: "Saved to MemoryNode." }],
          structuredContent: {
            status: "saved",
            decision: { code: "OK", message: "saved" },
            data: { deduped: false, policy_version: MCP_POLICY_VERSION },
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
            contentText: content,
            nonce,
            timestampMs,
          });
        }
      }
    },
  );

  server.registerTool(
    "memory_forget",
    {
      description: MEMORY_FORGET_DESCRIPTION,
      inputSchema: {
        content: z.string().min(1).max(10_000).describe("Text describing what to forget; used for semantic lookup."),
        containerTag: z.string().max(128).optional().describe("Optional scope tag; maps to MemoryNode namespace."),
        nonce: z.string().min(8).optional().describe("Replay-protection nonce for mutating actions."),
        timestampMs: z.number().int().optional().describe("Replay-protection timestamp in epoch milliseconds."),
      },
    },
    async ({ content, containerTag, nonce, timestampMs }) => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(containerTag);
      const scope = toPolicyScope({ user_id, namespace });
      const actionId: McpActionId = "memory.forget";
      const decision = evaluateWithLog(actionId, {
        scope,
        contentText: content,
        nonce,
        timestampMs,
      });
      if (decision.status === "deny") {
        return formatDeniedForTool(actionId, scope, decision);
      }
      const mustComplete = decision.status === "allow" || decision.status === "degrade";
      try {
        logger.info({
          event: "mcp_tool",
          tool: "memory_forget",
          action: "forget",
          userId: user_id,
          project: namespace,
          workspace_id: auth.workspaceId,
          request_id: requestId,
          policy_version: MCP_POLICY_VERSION,
          decision_id: decision.decisionId,
        });
        const search = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "POST",
          "/v1/search",
          { user_id, namespace, query: content.slice(0, 2000), top_k: 3 },
          requestId,
        );
        if (!search.ok) {
          return toolError("cost_exceeded", "Search failed while trying to forget.");
        }
        const results = Array.isArray((search.data as { results?: unknown })?.results)
          ? (search.data as {
              results: Array<{ memory_id?: string; id?: string; score?: number }>;
            }).results
          : [];
        const top = results[0];
        const memoryId =
          typeof top?.memory_id === "string"
            ? top.memory_id
            : typeof (top as { id?: string } | undefined)?.id === "string"
              ? (top as { id: string }).id
              : null;
        const rawScore = typeof top?.score === "number" ? top.score : NaN;
        const confidence = normalizedConfidenceFromFusionScore(rawScore);

        if (!memoryId) {
          return {
            content: [{ type: "text" as const, text: "No match found." }],
            structuredContent: {
              status: "rejected",
              decision: { code: "NO_MATCH", message: "No match found." },
              data: { policy_version: MCP_POLICY_VERSION },
            },
          };
        }
        const second = results[1];
        const secondScore = typeof second?.score === "number" ? second.score : 0;
        const scoreGap = rawScore - secondScore;
        if (confidence < MIN_DELETE_CONFIDENCE || scoreGap < 0.12) {
          const token = hostedPolicy.issueConfirmationToken(
            {
              actionId,
              scope,
              nowMs: Date.now(),
            },
            memoryId,
          );
          const candidates = results.slice(0, 3).map((row) => ({
            memory_id:
              typeof row.memory_id === "string"
                ? row.memory_id
                : typeof row.id === "string"
                  ? row.id
                  : "",
            score: typeof row.score === "number" ? row.score : 0,
          }));
          return {
            content: [
              {
                type: "text" as const,
                text: "Ambiguous forget request. Confirmation required.",
              },
            ],
            structuredContent: {
              status: "needs_confirmation",
              decision: { code: "NEEDS_CONFIRMATION", message: "Confirmation required before deleting memory." },
              data: {
                confirmation_token: token.token,
                expires_at: new Date(token.expiresAt).toISOString(),
                candidates,
                policy_version: MCP_POLICY_VERSION,
              },
            },
          };
        }

        const trialForgetStandalone = trialExpiredWriteToolResult(deps);
        if (trialForgetStandalone) return trialForgetStandalone;

        const del = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "DELETE",
          `/v1/memories/${encodeURIComponent(memoryId)}`,
          undefined,
          requestId,
        );
        if (!del.ok) {
          const msg =
            typeof (del.data as { error?: { message?: string } })?.error?.message === "string"
              ? (del.data as { error: { message: string } }).error.message
              : "Delete failed";
          return toolError("confirmation_required", `Delete failed: ${msg}`);
        }
        invalidateScopeCache(auth.workspaceId, user_id, namespace);
        return {
          content: [{ type: "text" as const, text: `Forgot memory ${memoryId}.` }],
          structuredContent: {
            status: "forgot",
            decision: { code: "OK", message: "deleted" },
            data: { memory_id: memoryId, policy_version: MCP_POLICY_VERSION },
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
            contentText: content,
            nonce,
            timestampMs,
          });
        }
      }
    },
  );

  server.registerTool(
    "memory_forget_confirm",
    {
      description: MEMORY_FORGET_CONFIRM_DESCRIPTION,
      inputSchema: {
        containerTag: z.string().max(128).optional().describe("Optional scope tag; maps to MemoryNode namespace."),
        confirm: z
          .object({
            token: z.string().optional(),
            memory_id: z.string().optional(),
          })
          .describe("confirmation token from memory_forget and/or explicit memory_id"),
        nonce: z.string().min(8).optional().describe("Replay-protection nonce for mutating actions."),
        timestampMs: z.number().int().optional().describe("Replay-protection timestamp in epoch milliseconds."),
      },
    },
    async ({ containerTag, confirm, nonce, timestampMs }) => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(containerTag);
      const scope = toPolicyScope({ user_id, namespace });
      const actionId: McpActionId = "memory.confirm_forget";
      const decision = evaluateWithLog(actionId, {
        scope,
        nonce,
        timestampMs,
      });
      if (decision.status === "deny") {
        return formatDeniedForTool(actionId, scope, decision);
      }
      const mustComplete = decision.status === "allow" || decision.status === "degrade";
      try {
        const token = confirm?.token ?? "";
        const memoryId = confirm?.memory_id ?? "";
        if (!token && !memoryId) {
          return toolError("confirmation_required", "confirm_forget requires token or memory_id.");
        }
        if (token) {
          const tokenDecision = hostedPolicy.consumeConfirmationToken(
            {
              actionId,
              scope,
              nowMs: Date.now(),
            },
            token,
            memoryId || undefined,
          );
          if (tokenDecision.status === "deny") {
            return formatDeniedForTool(actionId, scope, tokenDecision);
          }
        }
        const targetId = memoryId || confirm?.memory_id;
        if (!targetId) {
          return toolError("confirmation_required", "No memory_id available for confirm_forget.");
        }
        const trialConfirm = trialExpiredWriteToolResult(deps);
        if (trialConfirm) return trialConfirm;
        const del = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "DELETE",
          `/v1/memories/${encodeURIComponent(targetId)}`,
          undefined,
          requestId,
        );
        if (!del.ok) {
          const msg =
            typeof (del.data as { error?: { message?: string } })?.error?.message === "string"
              ? (del.data as { error: { message: string } }).error.message
              : "Delete failed";
          return toolError("confirmation_required", `Delete failed: ${msg}`);
        }
        invalidateScopeCache(auth.workspaceId, user_id, namespace);
        return {
          content: [{ type: "text" as const, text: `Forgot memory ${targetId}.` }],
          structuredContent: {
            status: "forgot",
            decision: { code: "OK", message: "confirmed_delete" },
            data: { memory_id: targetId, policy_version: MCP_POLICY_VERSION },
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
            nonce,
            timestampMs,
          });
        }
      }
    },
  );
}
