import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deriveContextSignals } from "@memorynodeai/shared";
import { z } from "zod";
import type { HostedBrandedDeps } from "../../adapters/hosted.js";
import { formatDeniedForTool, toolError } from "../../hosted/policyResponses.js";
import { trialExpiredWriteToolResult } from "../../hosted/trialWriteGate.js";
import {
  CONTEXT_BUDGET_CHARS,
  RECALL_TOP_K,
  buildContextPayload,
  buildProfileEngine,
  readRows,
  truncateContextSections,
} from "../../hosted/helpers.js";

const CONTEXT_PACK_DESCRIPTION = [
  "WHAT: Assembles a complete prompt-ready context bundle from memory — profile, recent history, ranked recall results — formatted for direct injection into a system prompt.",
  "WHEN: Call this at the start of a conversation turn when you want the richest possible memory context without building it yourself.",
  "INSTEAD: Use `search` if you need raw search results to process yourself rather than a pre-assembled bundle.",
  "RETURNS: A structured context object with profile, memories, and a ready-to-use prompt string.",
].join("\n");

const IDENTITY_GET_DESCRIPTION = [
  "WHAT: Returns the authenticated MemoryNode workspace scope for this MCP session — workspace id, default user slice, namespace / container tag, policy versions, product tier, and trial metadata when present.",
  "WHEN: Call this when you need to confirm which project or namespace you are writing to before saving memory or interpreting search results.",
  "INSTEAD: There is no substitute for explicit scope checks; use this tool rather than guessing from prior chat context.",
  "RETURNS: Structured identity fields including `workspace_id`, `namespace`, session id, client label, `product_plan`, optional `api_plan` (pro/team), trial flags, `MCP_POLICY_VERSION`, and `TOOL_MANIFEST_VERSION`.",
].join("\n");

export function registerProfileFamily(server: McpServer, deps: HostedBrandedDeps): void {
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
    TOOL_MANIFEST_VERSION,
    mcpCache,
    resolveScope,
    toPolicyScope,
    evaluateWithLog,
    getSessionId,
    aliasBehavior,
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

  const registerContextLike = (toolName: "context" | "context_pack", description: string) => {
    server.registerTool(
      toolName,
      {
        description,
        inputSchema: {
          query: z.string().min(1).max(2000),
          containerTag: z.string().max(128).optional(),
          profile: z.enum(["balanced", "precision", "recall"]).optional().default("balanced"),
          top_k: z.number().int().min(1).max(10).optional().default(RECALL_TOP_K),
        },
      },
      async ({ query, containerTag, profile, top_k }) => {
        const execStart = Date.now();
        const { user_id, namespace } = resolveScope(containerTag);
        const scope = toPolicyScope({ user_id, namespace });
        const decision = evaluateWithLog("context", {
          scope,
          queryText: query,
          topK: top_k,
        });
        if (decision.status === "deny") {
          return formatDeniedForTool("context", scope, decision);
        }
        const effectiveTopK = decision.appliedTopK ?? top_k;
        try {
          const scopeCacheKey = `${auth.workspaceId}:${user_id}:${namespace}`;
          const cacheKey = mcpCache.makeKey({
            tool: "context",
            scope: scopeCacheKey,
            query: `${query}:${effectiveTopK}:${profile}`,
            policyVersion: MCP_POLICY_VERSION,
          });
          const cached = await mcpCache.getOrCompute(cacheKey, { tool: "context", scope: scopeCacheKey }, async () => {
            const search = await postSearch({ user_id, namespace, query, top_k: effectiveTopK });
            if (!search.ok) {
              return toolError("cost_exceeded", "Search failed for context.");
            }
            const includeProfile = decision.degradeLevel !== "disable_profile" && profile !== "precision";
            const list = includeProfile
              ? await getMemoriesPage({ user_id, namespace }, 8)
              : { ok: true, status: 200, data: { results: [] as Array<{ text?: string; created_at?: string }> } };

            const context = buildContextPayload({
              query,
              searchRows: readRows(search.data),
              recentRows: readRows(list.data).map((r) => ({ text: r.text, created_at: r.created_at })),
            });
            const truncated = truncateContextSections(context);
            const scoredRows = readRows(search.data);
            const topScore = typeof scoredRows[0]?.score === "number" ? scoredRows[0].score : 0;
            const secondScore = typeof scoredRows[1]?.score === "number" ? scoredRows[1].score : 0;
            const sourceCount = new Set(
              truncated.relevantHistory.map((x) => x.memory_id).filter((x) => typeof x === "string" && x.length > 0),
            ).size;
            const signals = deriveContextSignals({
              topScore,
              secondScore,
              sourceCount,
              totalSourceCount: truncated.relevantHistory.length,
              memoryTexts: truncated.relevantHistory.map((item) => item.text),
              truncated: truncated.truncated || decision.status === "degrade",
            });
            const status = decision.status === "degrade" ? "degraded" : "ok";
            const profileEngine = buildProfileEngine({
              workspaceId: auth.workspaceId,
              containerTag: namespace,
              recentTexts: truncated.profileFacts,
              historyTexts: truncated.relevantHistory.map((x) => x.text),
            });
            const response = {
              content: [
                {
                  type: "text" as const,
                  text: [
                    "User Context:",
                    ...truncated.profileFacts.map((x) => `- ${x}`),
                    "",
                    "Relevant History:",
                    ...truncated.relevantHistory.map((x) => `- ${x.text}`),
                    "",
                    "Guidance:",
                    ...truncated.guidance.map((x) => `- ${x}`),
                  ].join("\n"),
                },
              ],
              structuredContent: {
                status,
                context: {
                  profileFacts: truncated.profileFacts,
                  relevantHistory: truncated.relevantHistory,
                  guidance: truncated.guidance,
                },
                profile_engine: profileEngine,
                meta: {
                  budget_chars: CONTEXT_BUDGET_CHARS,
                  used_chars: truncated.usedChars,
                  truncated: signals.truncated,
                  truncation_steps: truncated.steps,
                  confidence: signals.confidence,
                  source_count: signals.source_count,
                  recall_strength: signals.recall_strength,
                  diversity_score: signals.diversity_score,
                  redundancy_penalty: signals.redundancy_penalty,
                  integrity_score: signals.integrity_score,
                  policy_version: MCP_POLICY_VERSION,
                },
              },
            };
            return response;
          });
          return cached.value;
        } finally {
          hostedPolicy.recordExecution({
            actionId: "context",
            decision: decision.status,
            reason: decision.reasonCode,
            latencyMs: Date.now() - execStart,
            sessionId: scope.sessionId,
            scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
          });
          hostedPolicy.complete({
            actionId: "context",
            scope,
            nowMs: Date.now(),
            queryText: query,
            topK: effectiveTopK,
          });
        }
      },
    );
  };

  registerContextLike("context", "Generate bounded structured context for model responses.");
  registerContextLike("context_pack", CONTEXT_PACK_DESCRIPTION);

  server.registerTool(
    "identity_get",
    {
      description: IDENTITY_GET_DESCRIPTION,
      outputSchema: {
        workspace_id: z.string(),
        user_id: z.string(),
        namespace: z.string(),
        container_tag: z.string(),
        session_id: z.string(),
        client: z.string(),
        policy_version: z.string(),
        tool_manifest_version: z.string(),
        product_plan: z.enum(["indie", "studio", "team"]).optional(),
        api_plan: z.enum(["pro", "team"]).optional(),
        trial: z.boolean().optional(),
        trial_expires_at: z.string().nullable().optional(),
      },
    },
    async () => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const decision = evaluateWithLog("whoAmI", { scope });
      if (decision.status === "deny") {
        return formatDeniedForTool("whoAmI", scope, decision);
      }
      const sessionId = getSessionId() ?? "";
      try {
        return {
          content: [],
          structuredContent: {
            status: "ok",
            identity: {
              workspace_id: auth.workspaceId,
              user_id,
              namespace,
              container_tag: namespace,
              session_id: sessionId,
              client: "memorynode-mcp-http",
              policy_version: MCP_POLICY_VERSION,
              tool_manifest_version: TOOL_MANIFEST_VERSION,
              scoped_container_tag: auth.scopedContainerTag ?? null,
              product_plan: auth.productPlan,
              api_plan: auth.plan,
              trial: auth.trial ?? false,
              trial_expires_at: auth.trialExpiresAt ?? null,
            },
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId: "whoAmI",
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        hostedPolicy.complete({
          actionId: "whoAmI",
          scope,
          nowMs: Date.now(),
        });
      }
    },
  );

  server.registerTool(
    "whoAmI",
    {
      description: "Return the active MemoryNode API identity for this MCP session.",
      outputSchema: {
        workspace_id: z.string(),
        user_id: z.string(),
        namespace: z.string(),
        container_tag: z.string(),
        session_id: z.string(),
        client: z.string(),
        policy_version: z.string(),
      },
    },
    async () => {
      const execStart = Date.now();
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const decision = evaluateWithLog("whoAmI", { scope });
      if (decision.status === "deny") {
        return formatDeniedForTool("whoAmI", scope, decision);
      }
      const sessionId = getSessionId() ?? "";
      try {
        return {
          content: [],
          structuredContent: {
            status: "ok",
            identity: {
              workspace_id: auth.workspaceId,
              user_id,
              namespace,
              container_tag: namespace,
              session_id: sessionId,
              client: "memorynode-mcp-http",
              policy_version: MCP_POLICY_VERSION,
              scoped_container_tag: auth.scopedContainerTag ?? null,
              product_plan: auth.productPlan,
              api_plan: auth.plan,
              trial: auth.trial ?? false,
              trial_expires_at: auth.trialExpiresAt ?? null,
            },
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId: "whoAmI",
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        hostedPolicy.complete({
          actionId: "whoAmI",
          scope,
          nowMs: Date.now(),
        });
      }
    },
  );

  server.registerTool(
    "memory_context",
    {
      description: "Deprecated alias for context.",
      inputSchema: {
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ query, limit }) => {
      const alias = aliasBehavior("memory_context", "context");
      if (alias.blocked) return alias.response;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const decision = evaluateWithLog("context", { scope, queryText: query, topK: limit ?? RECALL_TOP_K });
      if (decision.status === "deny") return formatDeniedForTool("context", scope, decision);
      try {
        const search = await postSearch({
          user_id,
          namespace,
          query,
          top_k: decision.appliedTopK ?? limit ?? RECALL_TOP_K,
        });
        if (!search.ok) return toolError("cost_exceeded", "Context lookup failed.");
        const rows = readRows(search.data);
        const body = rows.map((r, i) => `${i + 1}. ${r.text ?? ""}`).join("\n");
        return {
          content: [{ type: "text" as const, text: body || "No context found." }],
          structuredContent: {
            deprecated: true,
            alias_for: "context",
            policy_version: MCP_POLICY_VERSION,
            ...(alias.warning ? alias.warning : {}),
          },
        };
      } finally {
        hostedPolicy.complete({
          actionId: "context",
          scope,
          nowMs: Date.now(),
          queryText: query,
          topK: limit ?? RECALL_TOP_K,
        });
      }
    },
  );

  server.registerTool(
    "memory_insert",
    {
      description: "Deprecated alias for memory save.",
      inputSchema: {
        content: z.string().min(1).max(10_000),
        nonce: z.string().min(8),
        timestampMs: z.number().int(),
      },
    },
    async ({ content, nonce, timestampMs }) => {
      const alias = aliasBehavior("memory_insert", "memory");
      if (alias.blocked) return alias.response;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const decision = evaluateWithLog("memory.save", {
        scope,
        contentText: content,
        nonce,
        timestampMs,
      });
      if (decision.status === "deny") return formatDeniedForTool("memory.save", scope, decision);
      try {
        const trialBlock = trialExpiredWriteToolResult(deps);
        if (trialBlock) return trialBlock;
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "POST",
          "/v1/memories",
          { user_id, namespace, text: content },
          requestId,
        );
        if (!out.ok) return toolError("weak_signal", "Insert failed.");
        return {
          content: [{ type: "text" as const, text: "Saved to MemoryNode." }],
          structuredContent: {
            deprecated: true,
            alias_for: "memory(save)",
            policy_version: MCP_POLICY_VERSION,
            ...(alias.warning ? alias.warning : {}),
          },
        };
      } finally {
        hostedPolicy.complete({
          actionId: "memory.save",
          scope,
          nowMs: Date.now(),
          contentText: content,
          nonce,
          timestampMs,
        });
      }
    },
  );

  server.registerTool(
    "whoami",
    {
      description: "Deprecated alias for whoAmI.",
      inputSchema: {},
    },
    async () => {
      const alias = aliasBehavior("whoami", "whoAmI");
      if (alias.blocked) return alias.response;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const decision = evaluateWithLog("whoAmI", { scope });
      if (decision.status === "deny") return formatDeniedForTool("whoAmI", scope, decision);
      hostedPolicy.complete({
        actionId: "whoAmI",
        scope,
        nowMs: Date.now(),
      });
      return {
        content: [{ type: "text" as const, text: "Use tool whoAmI (camelCase)." }],
        structuredContent: {
          deprecated: true,
          alias_for: "whoAmI",
          policy_version: MCP_POLICY_VERSION,
          ...(alias.warning ? alias.warning : {}),
        },
      };
    },
  );
}
