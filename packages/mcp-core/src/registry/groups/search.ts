import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HostedBrandedDeps } from "../../adapters/hosted.js";
import { formatDeniedForTool, toolError } from "../../hosted/policyResponses.js";
import {
  RECALL_TOP_K,
  buildProfileEngine,
  buildRecallReasoning,
  formatSearchResults,
  normalizedConfidenceFromFusionScore,
  readRows,
} from "../../hosted/helpers.js";

const SEARCH_DESCRIPTION = [
  "WHAT: Performs hybrid semantic and keyword search across all stored memories for a user or account.",
  "WHEN: Call this when you need to find specific facts, preferences, or past context before responding.",
  "INSTEAD: Use `context_pack` if you want a fully assembled prompt-ready context block rather than raw search results.",
  "RETURNS: Ranked list of matching memory chunks with relevance scores.",
].join("\n");

export function registerSearchFamily(server: McpServer, deps: HostedBrandedDeps): void {
  const {
    env,
    restApiOrigin,
    apiKey,
    auth,
    requestId,
    hostedPolicy,
    internalJson,
    hostedDirectSearch,
    hostedDirectListMemories,
    MCP_POLICY_VERSION,
    mcpCache,
    resolveScope,
    toPolicyScope,
    evaluateWithLog,
    logger,
  } = deps;

  const postSearch = async (body: { user_id: string; namespace: string; query: string; top_k: number }) => {
    if (hostedDirectSearch) {
      return hostedDirectSearch({
        user_id: body.user_id,
        namespace: body.namespace,
        query: body.query,
        top_k: body.top_k,
      });
    }
    return internalJson(env, restApiOrigin, apiKey, "POST", "/v1/search", body, requestId);
  };

  const getMemoriesPage = async (scope: { user_id: string; namespace: string }, page_size: number) => {
    if (hostedDirectListMemories) {
      return hostedDirectListMemories({
        user_id: scope.user_id,
        namespace: scope.namespace,
        page: 1,
        page_size,
      });
    }
    return internalJson(
      env,
      restApiOrigin,
      apiKey,
      "GET",
      `/v1/memories?user_id=${encodeURIComponent(scope.user_id)}&namespace=${encodeURIComponent(scope.namespace)}&page=1&page_size=${page_size}`,
      undefined,
      requestId,
    );
  };

  const registerRecallLike = (toolName: "recall" | "search", description: string) => {
    server.registerTool(
      toolName,
      {
        description,
        inputSchema: {
          query: z.string().min(1).describe("Search query."),
          includeProfile: z.boolean().optional().describe("Include a compact profile from recent memories (default true)."),
          containerTag: z.string().max(128).optional().describe("Optional scope tag; maps to MemoryNode namespace."),
          top_k: z.number().int().min(1).max(10).optional().describe("Bounded result count."),
        },
      },
      async ({ query, includeProfile, containerTag, top_k }) => {
        const execStart = Date.now();
        const include = includeProfile !== false;
        const { user_id, namespace } = resolveScope(containerTag);
        const scope = toPolicyScope({ user_id, namespace });
        const decision = evaluateWithLog("recall", {
          scope,
          queryText: query,
          topK: top_k ?? RECALL_TOP_K,
          includeProfile: include,
        });
        if (decision.status === "deny") {
          return formatDeniedForTool("recall", scope, decision);
        }
        const effectiveTopK = decision.appliedTopK ?? top_k ?? RECALL_TOP_K;
        logger.info({
          event: "mcp_tool",
          tool: toolName,
          userId: user_id,
          project: namespace,
          workspace_id: auth.workspaceId,
          request_id: requestId,
          policy_version: MCP_POLICY_VERSION,
          decision_id: decision.decisionId,
        });
        try {
          const scopeCacheKey = `${auth.workspaceId}:${user_id}:${namespace}`;
          const cacheKey = mcpCache.makeKey({
            tool: "recall",
            scope: scopeCacheKey,
            query: `${query}:${effectiveTopK}:${include ? 1 : 0}`,
            policyVersion: MCP_POLICY_VERSION,
          });
          const cached = await mcpCache.getOrCompute(cacheKey, { tool: "recall", scope: scopeCacheKey }, async () => {
            const out = await postSearch({ user_id, namespace, query, top_k: effectiveTopK });
            if (!out.ok) {
              const msg =
                typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
                  ? (out.data as { error: { message: string } }).error.message
                  : "Search failed";
              return toolError("cost_exceeded", msg);
            }
            const rawList = readRows(out.data).map((r) => ({
              memory_id: r.memory_id,
              chunk_id: "",
              chunk_index: 0,
              text: r.text,
              score: r.score,
            }));
            const resultsOut = rawList.map((r) => ({
              memory_id: r.memory_id ?? "",
              chunk_id: r.chunk_id ?? "",
              chunk_index: r.chunk_index ?? 0,
              text: typeof r.text === "string" ? r.text : "",
              score: typeof r.score === "number" ? r.score : 0,
            }));
            const topScore = typeof rawList[0]?.score === "number" ? rawList[0].score : 0;
            const confidence = normalizedConfidenceFromFusionScore(topScore);
            const reasoning = buildRecallReasoning(
              query,
              rawList.map((r) => ({ text: r.text })),
            );

            let profileBlock = "";
            let recentTextsForProfile: string[] = [];
            const includeEffective = include && decision.degradeLevel !== "disable_profile";
            if (includeEffective) {
              const list = await getMemoriesPage({ user_id, namespace }, 5);
              const recent = Array.isArray((list.data as { results?: { text?: string }[] })?.results)
                ? (list.data as { results: { text?: string }[] }).results
                : [];
              recentTextsForProfile = recent
                .map((r) => (typeof r.text === "string" ? r.text : ""))
                .filter((x) => x.length > 0);
              profileBlock =
                recent.length === 0
                  ? "_No recent rows for profile summary._"
                  : recent.map((r, i) => `${i + 1}. ${typeof r.text === "string" ? r.text : ""}`).join("\n");
            }
            const textBody = include
              ? `## Profile (recent)\n${profileBlock}\n\n## Recall\n${formatSearchResults(out.data)}`
              : formatSearchResults(out.data);
            const status = confidence < 0.35 ? "low_confidence" : decision.status === "degrade" ? "degraded" : "ok";
            const profileEngine = buildProfileEngine({
              workspaceId: auth.workspaceId,
              containerTag: namespace,
              recentTexts: recentTextsForProfile,
              historyTexts: resultsOut.map((r) => r.text),
            });
            const response = {
              content: [{ type: "text" as const, text: textBody }],
              structuredContent: {
                status,
                results: resultsOut,
                profile: { recent: includeEffective ? profileBlock : "" },
                profile_engine: profileEngine,
                meta: {
                  reasoning,
                  confidence,
                  scope: `${auth.workspaceId}:${user_id}/${namespace}`,
                  policy_version: MCP_POLICY_VERSION,
                  ...(decision.status === "degrade"
                    ? { degradation_applied: [decision.degradeLevel ?? "reduce_top_k"] }
                    : {}),
                },
              },
            };
            return response;
          });
          return cached.value;
        } finally {
          hostedPolicy.recordExecution({
            actionId: "recall",
            decision: decision.status,
            reason: decision.reasonCode,
            latencyMs: Date.now() - execStart,
            sessionId: scope.sessionId,
            scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
          });
          hostedPolicy.complete({
            actionId: "recall",
            scope,
            nowMs: Date.now(),
            queryText: query,
            topK: effectiveTopK,
          });
        }
      },
    );
  };

  registerRecallLike("recall", "Semantic search over MemoryNode memories; optional short profile summary.");
  registerRecallLike("search", SEARCH_DESCRIPTION);

  server.registerTool(
    "memory_search",
    {
      description: "Deprecated alias for recall.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ query, limit }) => {
      const alias = deps.aliasBehavior("memory_search", "recall");
      if (alias.blocked) return alias.response;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const decision = evaluateWithLog("recall", { scope, queryText: query, topK: limit ?? RECALL_TOP_K });
      if (decision.status === "deny") return formatDeniedForTool("recall", scope, decision);
      const out = await postSearch({
        user_id,
        namespace,
        query,
        top_k: decision.appliedTopK ?? limit ?? RECALL_TOP_K,
      });
      hostedPolicy.complete({
        actionId: "recall",
        scope,
        nowMs: Date.now(),
      });
      if (!out.ok) return toolError("cost_exceeded", "Search failed.");
      return {
        content: [{ type: "text" as const, text: formatSearchResults(out.data) }],
        structuredContent: {
          deprecated: true,
          alias_for: "recall",
          policy_version: MCP_POLICY_VERSION,
          ...(alias.warning ? alias.warning : {}),
        },
      };
    },
  );
}
