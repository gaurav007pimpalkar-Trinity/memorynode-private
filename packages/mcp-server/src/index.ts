import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MCP_POLICY_VERSION,
  McpPolicyEngine,
  deriveContextSignals,
  policyDeniedError,
  normalizeDeprecationPhase,
  resolveAliasDecision,
  type McpActionId,
  type PolicyScope,
} from "@memorynodeai/shared";
import { McpResponseCache } from "./cache.js";

const MEMORYNODE_API_KEY = process.env.MEMORYNODE_API_KEY;
const MEMORYNODE_BASE_URL = process.env.MEMORYNODE_BASE_URL;
const MEMORYNODE_USER_ID = process.env.MEMORYNODE_USER_ID ?? "default";
const MEMORYNODE_NAMESPACE = process.env.MEMORYNODE_NAMESPACE ?? "default";

if (!MEMORYNODE_API_KEY || typeof MEMORYNODE_API_KEY !== "string" || !MEMORYNODE_API_KEY.trim()) {
  console.error("MEMORYNODE_API_KEY is required. Set it in your environment or .env.");
  process.exit(1);
}
if (!MEMORYNODE_BASE_URL || typeof MEMORYNODE_BASE_URL !== "string" || !MEMORYNODE_BASE_URL.trim()) {
  console.error("MEMORYNODE_BASE_URL is required (e.g. https://api.memorynode.ai). Set it in your environment or .env.");
  process.exit(1);
}

const baseUrl = MEMORYNODE_BASE_URL.replace(/\/$/, "");
const apiKey = MEMORYNODE_API_KEY.trim();
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 10;
const SEARCH_LIMIT_DEFAULT = 5;
const INSERT_CONTENT_MAX = 10_000;
const METADATA_STRINGIFIED_MAX = 5 * 1024;
const CONTEXT_BUDGET_CHARS = 2500;
const policy = new McpPolicyEngine(undefined, {
  beforePolicy: (input) => {
    console.error(
      JSON.stringify({
        event: "mcp_policy_before",
        tool: input.actionId,
        session_id: input.scope.sessionId,
        policy_version: MCP_POLICY_VERSION,
      }),
    );
  },
  afterPolicy: (input, decision, latencyMs) => {
    console.error(
      JSON.stringify({
        event: "mcp_policy_after",
        tool: input.actionId,
        decision: decision.status,
        reason: decision.reasonCode ?? null,
        latency_ms: latencyMs,
        session_id: input.scope.sessionId,
        policy_version: MCP_POLICY_VERSION,
        scores: {
          similarity: decision.loopConfidence ?? null,
          novelty: decision.noveltyScore ?? null,
        },
      }),
    );
  },
});
const DEPRECATION_PHASE = normalizeDeprecationPhase(process.env.MEMORYNODE_MCP_DEPRECATION_PHASE);
const cache = new McpResponseCache({
  maxSize: 300,
  ttlByTool: {
    recall: 15_000,
    context: 8_000,
  },
});

type RestFetchOptions = { method: string; body?: Record<string, unknown>; headers?: Record<string, string> };

function mapRestStatusToMcpCode(status: number): string {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  return "internal_error";
}

async function restFetch(path: string, init: RestFetchOptions): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = await res.text();
  }
  if (!res.ok) {
    const errMsg =
      typeof data === "object" && data && "error" in (data as { error?: { message?: string } })
        ? (data as { error: { message?: string } }).error?.message
        : String(data);
    return { ok: false, status: res.status, error: errMsg };
  }
  return { ok: true, status: res.status, data };
}

function getScope(): PolicyScope {
  return {
    workspaceId: "stdio",
    keyId: "stdio",
    userId: MEMORYNODE_USER_ID,
    namespace: MEMORYNODE_NAMESPACE,
    sessionId: "stdio",
  };
}

function scopeKey(): string {
  return `stdio:${MEMORYNODE_USER_ID}:${MEMORYNODE_NAMESPACE}`;
}

function evaluate(actionId: McpActionId, args: {
  queryText?: string;
  contentText?: string;
  topK?: number;
  includeProfile?: boolean;
  nonce?: string;
  timestampMs?: number;
}) {
  return policy.evaluate({
    actionId,
    scope: getScope(),
    nowMs: Date.now(),
    queryText: args.queryText,
    contentText: args.contentText,
    topK: args.topK,
    includeProfile: args.includeProfile,
    nonce: args.nonce,
    timestampMs: args.timestampMs,
  });
}

function denied(actionId: McpActionId, decision: ReturnType<typeof evaluate>) {
  const d = policyDeniedError({
    code: decision.reasonCode ?? "rate_limit_exceeded",
    message: decision.message ?? "Request denied by policy.",
    retryAfterSec: decision.retryAfterSec,
    actionId,
    scope: getScope(),
    details: {
      ...(typeof decision.estimatedTokens === "number" ? { estimated_tokens: decision.estimatedTokens } : {}),
      ...(decision.budget ? { budget: decision.budget.max_total_tokens } : {}),
      ...(decision.budget ? { budget_tokens: decision.budget } : {}),
      ...(decision.costDecision ? { cost_decision: decision.costDecision } : {}),
      ...(decision.loopConfidence != null ? { confidence: decision.loopConfidence } : {}),
      ...(decision.matchedWindow ? { matched_window: decision.matchedWindow } : {}),
    },
  });
  return { content: [{ type: "text" as const, text: d.error.message }], structuredContent: d, isError: true };
}

function toolError(code: string, message: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: {
      error: {
        code,
        message,
        details: details ?? {},
      },
    },
    isError: true,
  };
}

function parseErrorMessage(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback;
  try {
    const parsed = JSON.parse(msg) as { message?: string };
    if (typeof parsed.message === "string" && parsed.message.length > 0) return parsed.message;
  } catch {
    // no-op
  }
  return msg;
}

function aliasBehavior(alias: string, canonical: string) {
  console.error(JSON.stringify({ event: "mcp_alias_usage", alias, canonical, phase: DEPRECATION_PHASE }));
  const decision = resolveAliasDecision(DEPRECATION_PHASE, canonical);
  if (decision.blocked) {
    return {
      blocked: true as const,
      response: toolError("weak_signal", `Deprecated tool '${alias}' is blocked. Use '${canonical}'.`, {
        warning: "deprecated_tool",
        use: canonical,
      }),
    };
  }
  return { blocked: false as const, warning: decision.warning };
}

function formatSearchResults(results: Array<{ text?: string; score?: number }>): string {
  return results
    .map((r, i) => `Result ${i + 1}\nScore: ${typeof r.score === "number" ? r.score.toFixed(2) : "—"}\nContent: ${typeof r.text === "string" ? r.text : ""}\n`)
    .join("\n");
}

async function searchRows(query: string, topK: number): Promise<Array<{ memory_id: string; text: string; score: number }>> {
  const out = await restFetch("/v1/search", {
    method: "POST",
    body: { user_id: MEMORYNODE_USER_ID, namespace: MEMORYNODE_NAMESPACE, query: query.trim(), top_k: topK },
  });
  if (!out.ok) throw new Error(JSON.stringify({ code: mapRestStatusToMcpCode(out.status), message: out.error ?? "Search failed" }));
  const rows = Array.isArray((out.data as { results?: unknown })?.results)
    ? (out.data as { results: Array<{ memory_id?: string; text?: string; score?: number }> }).results
    : [];
  return rows.map((r) => ({
    memory_id: typeof r.memory_id === "string" ? r.memory_id : "",
    text: typeof r.text === "string" ? r.text : "",
    score: typeof r.score === "number" ? r.score : 0,
  }));
}

async function listRecent(limit: number): Promise<string[]> {
  const out = await restFetch(
    `/v1/memories?user_id=${encodeURIComponent(MEMORYNODE_USER_ID)}&namespace=${encodeURIComponent(MEMORYNODE_NAMESPACE)}&page=1&page_size=${Math.max(1, Math.min(20, limit))}`,
    { method: "GET" },
  );
  if (!out.ok) return [];
  const rows = Array.isArray((out.data as { results?: unknown })?.results)
    ? (out.data as { results: Array<{ text?: string }> }).results
    : [];
  return rows.map((r) => (typeof r.text === "string" ? r.text : "")).filter((x) => x.length > 0);
}

function buildContext(query: string, rows: Array<{ memory_id: string; text: string; score: number }>, recent: string[]) {
  const profileBudget = Math.floor(CONTEXT_BUDGET_CHARS * 0.3);
  const historyBudget = Math.floor(CONTEXT_BUDGET_CHARS * 0.55);
  const guidanceBudget = CONTEXT_BUDGET_CHARS - profileBudget - historyBudget;
  const profileFacts: string[] = [];
  const relevantHistory: Array<{ memory_id: string; text: string; score: number }> = [];
  const guidance = [
    "Use context-backed facts before making assumptions.",
    "If confidence is low, ask a clarifying question.",
    `Query intent: ${query.slice(0, 200)}`,
  ];
  let profileUsed = 0;
  for (const x of recent) {
    if (profileUsed + x.length > profileBudget) break;
    profileFacts.push(x);
    profileUsed += x.length;
  }
  let historyUsed = 0;
  for (const x of rows) {
    if (historyUsed + x.text.length > historyBudget) break;
    relevantHistory.push(x);
    historyUsed += x.text.length;
  }
  const keptGuidance: string[] = [];
  let guidanceUsed = 0;
  for (const x of guidance) {
    if (guidanceUsed + x.length > guidanceBudget) break;
    keptGuidance.push(x);
    guidanceUsed += x.length;
  }
  return {
    profileFacts,
    relevantHistory,
    guidance: keptGuidance,
    usedChars: profileUsed + historyUsed + guidanceUsed,
    truncated: profileFacts.length < recent.length || relevantHistory.length < rows.length || keptGuidance.length < guidance.length,
  };
}

const server = new McpServer(
  { name: "memorynode-mcp", version: "1.1.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.registerTool("recall", {
  description: "Find relevant past information in memory.",
  inputSchema: {
    query: z.string().min(1),
    top_k: z.number().int().min(SEARCH_LIMIT_MIN).max(SEARCH_LIMIT_MAX).optional().default(SEARCH_LIMIT_DEFAULT),
    includeProfile: z.boolean().optional().default(true),
  },
}, async ({ query, top_k, includeProfile }) => {
  const execStart = Date.now();
  const decision = evaluate("recall", { queryText: query, topK: top_k, includeProfile });
  if (decision.status === "deny") return denied("recall", decision);
  const effectiveTopK = decision.appliedTopK ?? top_k;
  try {
    const key = cache.makeKey({
      tool: "recall",
      scope: scopeKey(),
      query: `${query}:${effectiveTopK}:${includeProfile ? 1 : 0}`,
      policyVersion: MCP_POLICY_VERSION,
    });
    const result = await cache.getOrCompute(key, { tool: "recall", scope: scopeKey() }, async () => {
      const rows = await searchRows(query, effectiveTopK);
      const recent = includeProfile && decision.degradeLevel !== "disable_profile" ? await listRecent(5) : [];
      const text = `${recent.length > 0 ? `## Profile (recent)\n${recent.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\n` : ""}## Recall\n${formatSearchResults(rows)}`;
      const confidence = rows.length > 0 ? Math.min(1, Math.max(0, (rows[0]?.score ?? 0) / 0.08)) : 0;
      return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        status: confidence < 0.35 ? "low_confidence" : decision.status === "degrade" ? "degraded" : "ok",
        results: rows,
        meta: {
          confidence,
          policy_version: MCP_POLICY_VERSION,
          ...(decision.status === "degrade" ? { degradation_applied: [decision.degradeLevel ?? "reduce_top_k"] } : {}),
        },
      },
    };
    });
    return result.value;
  } catch (err) {
    const msg = parseErrorMessage(err, "Recall failed");
    return toolError("cost_exceeded", msg);
  } finally {
    policy.recordExecution({
      actionId: "recall",
      decision: decision.status,
      reason: decision.reasonCode,
      latencyMs: Date.now() - execStart,
      sessionId: getScope().sessionId,
      scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
    });
    policy.complete({ actionId: "recall", scope: getScope(), nowMs: Date.now(), queryText: query, topK: effectiveTopK });
  }
});

server.registerTool("context", {
  description: "Generate structured context to improve model responses.",
  inputSchema: {
    query: z.string().min(1).max(2000),
    top_k: z.number().int().min(SEARCH_LIMIT_MIN).max(SEARCH_LIMIT_MAX).optional().default(SEARCH_LIMIT_DEFAULT),
    profile: z.enum(["balanced", "precision", "recall"]).optional().default("balanced"),
  },
}, async ({ query, top_k, profile }) => {
  const execStart = Date.now();
  const decision = evaluate("context", { queryText: query, topK: top_k });
  if (decision.status === "deny") return denied("context", decision);
  const effectiveTopK = decision.appliedTopK ?? top_k;
  try {
    const key = cache.makeKey({
      tool: "context",
      scope: scopeKey(),
      query: `${query}:${effectiveTopK}:${profile}`,
      policyVersion: MCP_POLICY_VERSION,
    });
    const result = await cache.getOrCompute(key, { tool: "context", scope: scopeKey() }, async () => {
      const rows = await searchRows(query, effectiveTopK);
      const recent = profile !== "precision" && decision.degradeLevel !== "disable_profile" ? await listRecent(8) : [];
      const context = buildContext(query, rows, recent);
      const topScore = rows[0]?.score ?? 0;
      const secondScore = rows[1]?.score ?? 0;
      const sourceCount = new Set(context.relevantHistory.map((x) => x.memory_id).filter((x) => x.length > 0)).size;
      const signals = deriveContextSignals({
        topScore,
        secondScore,
        sourceCount,
        totalSourceCount: context.relevantHistory.length,
        memoryTexts: context.relevantHistory.map((item) => item.text),
        truncated: context.truncated || decision.status === "degrade",
      });
      const text = [
        "User Context:",
        ...context.profileFacts.map((x) => `- ${x}`),
        "",
        "Relevant History:",
        ...context.relevantHistory.map((x) => `- ${x.text}`),
        "",
        "Guidance:",
        ...context.guidance.map((x) => `- ${x}`),
      ].join("\n");
      return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        status: decision.status === "degrade" ? "degraded" : "ok",
        context: {
          profileFacts: context.profileFacts,
          relevantHistory: context.relevantHistory,
          guidance: context.guidance,
        },
        meta: {
          budget_chars: CONTEXT_BUDGET_CHARS,
          used_chars: context.usedChars,
          truncated: signals.truncated,
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
    });
    return result.value;
  } catch (err) {
    const msg = parseErrorMessage(err, "Context failed");
    return toolError("cost_exceeded", msg);
  } finally {
    policy.recordExecution({
      actionId: "context",
      decision: decision.status,
      reason: decision.reasonCode,
      latencyMs: Date.now() - execStart,
      sessionId: getScope().sessionId,
      scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
    });
    policy.complete({ actionId: "context", scope: getScope(), nowMs: Date.now(), queryText: query, topK: effectiveTopK });
  }
});

server.registerTool("memory", {
  description: "Save important user information for future conversations.",
  inputSchema: {
    action: z.enum(["save"]).optional().default("save"),
    content: z.string().min(1).max(INSERT_CONTENT_MAX),
    metadata: z.record(z.unknown()).optional(),
    nonce: z.string().min(8),
    timestampMs: z.number().int(),
  },
}, async ({ content, metadata, nonce, timestampMs }) => {
  const execStart = Date.now();
  const decision = evaluate("memory.save", { contentText: content, nonce, timestampMs });
  if (decision.status === "deny") return denied("memory.save", decision);
  try {
    if (metadata !== undefined) {
      const str = JSON.stringify(metadata);
      if (str.length > METADATA_STRINGIFIED_MAX) {
        throw new Error(JSON.stringify({ code: "invalid_request", message: "metadata stringified exceeds 5KB" }));
      }
    }
    const out = await restFetch("/v1/memories", {
      method: "POST",
      body: {
        user_id: MEMORYNODE_USER_ID,
        namespace: MEMORYNODE_NAMESPACE,
        text: content,
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    });
    if (!out.ok) throw new Error(JSON.stringify({ code: mapRestStatusToMcpCode(out.status), message: out.error ?? "Insert failed" }));
    cache.invalidateScope(scopeKey());
    return {
      content: [{ type: "text" as const, text: "Memory stored successfully." }],
      structuredContent: {
        status: "saved",
        decision: { code: "OK", message: "saved" },
        data: { deduped: false, policy_version: MCP_POLICY_VERSION },
      },
    };
  } catch (err) {
    const msg = parseErrorMessage(err, "Memory save failed");
    return toolError("weak_signal", msg);
  } finally {
    policy.recordExecution({
      actionId: "memory.save",
      decision: decision.status,
      reason: decision.reasonCode,
      latencyMs: Date.now() - execStart,
      sessionId: getScope().sessionId,
      scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
    });
    policy.complete({ actionId: "memory.save", scope: getScope(), nowMs: Date.now(), contentText: content, nonce, timestampMs });
  }
});

server.registerTool("whoAmI", {
  description: "Identify current user scope and policy contract version.",
  outputSchema: {
    workspace_id: z.string(),
    user_id: z.string(),
    namespace: z.string(),
    session_id: z.string(),
    client: z.string(),
    policy_version: z.string(),
  },
}, async () => ({
  content: [],
  structuredContent: {
    status: "ok",
    identity: {
      workspace_id: "stdio",
      user_id: MEMORYNODE_USER_ID,
      namespace: MEMORYNODE_NAMESPACE,
      session_id: "stdio",
      client: "memorynode-mcp-stdio",
      policy_version: MCP_POLICY_VERSION,
    },
  },
}));

// Alias compatibility
server.registerTool("memory_search", {
  description: "Deprecated alias for recall.",
  inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional() },
}, async ({ query, limit }) => {
  const alias = aliasBehavior("memory_search", "recall");
  if (alias.blocked) return alias.response;
  try {
    const rows = await searchRows(query, limit ?? SEARCH_LIMIT_DEFAULT);
    return {
      content: [{ type: "text" as const, text: formatSearchResults(rows) }],
      structuredContent: {
        deprecated: true,
        alias_for: "recall",
        policy_version: MCP_POLICY_VERSION,
        ...(alias.warning ? alias.warning : {}),
      },
    };
  } catch (err) {
    const msg = parseErrorMessage(err, "Search failed");
    return toolError("cost_exceeded", msg);
  }
});

server.registerTool("memory_context", {
  description: "Deprecated alias for context.",
  inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional() },
}, async ({ query, limit }) => {
  const alias = aliasBehavior("memory_context", "context");
  if (alias.blocked) return alias.response;
  try {
    const rows = await searchRows(query, limit ?? SEARCH_LIMIT_DEFAULT);
    return {
      content: [{ type: "text" as const, text: rows.map((r, i) => `Result ${i + 1}: ${r.text}`).join("\n") || "No context found." }],
      structuredContent: {
        deprecated: true,
        alias_for: "context",
        policy_version: MCP_POLICY_VERSION,
        ...(alias.warning ? alias.warning : {}),
      },
    };
  } catch (err) {
    const msg = parseErrorMessage(err, "Context lookup failed");
    return toolError("cost_exceeded", msg);
  }
});

server.registerTool("memory_insert", {
  description: "Deprecated alias for memory save.",
  inputSchema: {
    content: z.string().min(1).max(INSERT_CONTENT_MAX),
    metadata: z.record(z.unknown()).optional(),
    nonce: z.string().min(8),
    timestampMs: z.number().int(),
  },
}, async ({ content, metadata, nonce, timestampMs }) => {
  const alias = aliasBehavior("memory_insert", "memory");
  if (alias.blocked) return alias.response;
  const decision = evaluate("memory.save", { contentText: content, nonce, timestampMs });
  if (decision.status === "deny") return denied("memory.save", decision);
  try {
    const out = await restFetch("/v1/memories", {
      method: "POST",
      body: {
        user_id: MEMORYNODE_USER_ID,
        namespace: MEMORYNODE_NAMESPACE,
        text: content,
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    });
    if (!out.ok) throw new Error(JSON.stringify({ code: mapRestStatusToMcpCode(out.status), message: out.error ?? "Insert failed" }));
    cache.invalidateScope(scopeKey());
    return {
      content: [{ type: "text" as const, text: "Memory stored successfully." }],
      structuredContent: {
        deprecated: true,
        alias_for: "memory(save)",
        policy_version: MCP_POLICY_VERSION,
        ...(alias.warning ? alias.warning : {}),
      },
    };
  } catch (err) {
    const msg = parseErrorMessage(err, "Insert failed");
    return toolError("weak_signal", msg);
  } finally {
    policy.complete({ actionId: "memory.save", scope: getScope(), nowMs: Date.now(), contentText: content, nonce, timestampMs });
  }
});

server.registerResource(
  "memory-search",
  new ResourceTemplate("memory://search{?q}", { list: undefined }),
  { description: "Semantic search over persistent memory. Use URI memory://search?q=..." },
  async (uri) => {
    const q = uri.searchParams.get("q");
    if (!q || !q.trim()) throw new Error(JSON.stringify({ code: "invalid_request", message: "Missing required query param: q" }));
    const rows = await searchRows(q, SEARCH_LIMIT_DEFAULT);
    const markdown = rows.map((r, i) => `## Result ${i + 1}\n**Score:** ${r.score.toFixed(2)}\n\n${r.text}\n`).join("\n");
    return { contents: [{ uri: uri.toString(), mimeType: "text/markdown", text: markdown }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
