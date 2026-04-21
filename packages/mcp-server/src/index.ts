import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MIN_DELETE_CONFIDENCE, normalizedConfidenceFromFusionScore } from "@memorynodeai/mcp-core";
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
import { resolveStdioScope } from "./stdioScope.js";

const MEMORYNODE_API_KEY = process.env.MEMORYNODE_API_KEY;
const MEMORYNODE_BASE_URL = process.env.MEMORYNODE_BASE_URL;

/** Policy / identity display labels (stdio has no API key workspace id; override for multi-tenant agents). */
const POLICY_WORKSPACE_ID = (process.env.MEMORYNODE_POLICY_WORKSPACE_ID ?? "stdio").trim() || "stdio";
const POLICY_KEY_ID = (process.env.MEMORYNODE_POLICY_KEY_ID ?? "stdio").trim() || "stdio";
const MCP_SESSION_ID = (process.env.MEMORYNODE_SESSION_ID ?? "stdio").trim() || "stdio";

function scopedContainerTagForIdentity(): string | undefined {
  const raw = (process.env.MEMORYNODE_SCOPED_CONTAINER_TAG ?? "").trim();
  return raw.length > 0 ? raw : undefined;
}

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
/** Matches REST list default for profile resource parity. */
const PROFILE_RESOURCE_PAGE_SIZE = 15;
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

function getScopeForTool(containerTag?: string | null): PolicyScope {
  const { user_id, namespace } = resolveStdioScope(containerTag);
  return {
    workspaceId: POLICY_WORKSPACE_ID,
    keyId: POLICY_KEY_ID,
    userId: user_id,
    namespace,
    sessionId: MCP_SESSION_ID,
  };
}

function scopeCacheKey(containerTag?: string | null): string {
  const { user_id, namespace } = resolveStdioScope(containerTag);
  return `${POLICY_WORKSPACE_ID}:${user_id}:${namespace}`;
}

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

function evaluatePolicy(
  actionId: McpActionId,
  containerTag: string | null | undefined,
  args: {
    queryText?: string;
    contentText?: string;
    topK?: number;
    includeProfile?: boolean;
    nonce?: string;
    timestampMs?: number;
  },
) {
  return policy.evaluate({
    actionId,
    scope: getScopeForTool(containerTag),
    nowMs: Date.now(),
    queryText: args.queryText,
    contentText: args.contentText,
    topK: args.topK,
    includeProfile: args.includeProfile,
    nonce: args.nonce,
    timestampMs: args.timestampMs,
  });
}

function denied(actionId: McpActionId, decision: ReturnType<typeof evaluatePolicy>, scope: PolicyScope) {
  const d = policyDeniedError({
    code: decision.reasonCode ?? "rate_limit_exceeded",
    message: decision.message ?? "Request denied by policy.",
    retryAfterSec: decision.retryAfterSec,
    actionId,
    scope,
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

async function searchRows(
  query: string,
  topK: number,
  containerTag?: string | null,
): Promise<Array<{ memory_id: string; text: string; score: number }>> {
  const { user_id, namespace } = resolveStdioScope(containerTag);
  const out = await restFetch("/v1/search", {
    method: "POST",
    body: { user_id, namespace, query: query.trim(), top_k: topK },
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

async function listRecent(limit: number, containerTag?: string | null): Promise<string[]> {
  const { user_id, namespace } = resolveStdioScope(containerTag);
  const out = await restFetch(
    `/v1/memories?user_id=${encodeURIComponent(user_id)}&namespace=${encodeURIComponent(namespace)}&page=1&page_size=${Math.max(1, Math.min(20, limit))}`,
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

type ProfileEngineView = {
  identity: { workspace_id: string; container_tag: string };
  preferences: string[];
  projects: string[];
  goals: string[];
  constraints: string[];
  last_updated: string;
  confidence: number;
};

function buildProfileEngine(
  args: { recentTexts: string[]; historyTexts: string[]; namespace: string },
): ProfileEngineView {
  const all = [...args.recentTexts, ...args.historyTexts].map((x) => x.trim()).filter((x) => x.length > 0);
  const pick = (matcher: RegExp, limit: number): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const ordered = [...all].reverse();
    for (const row of ordered) {
      if (!matcher.test(row.toLowerCase())) continue;
      const key = row.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  };
  const preferences = pick(/\bprefer|likes|favorite|usually\b/, 8);
  const projects = pick(/\bproject|building|working on|repo\b/, 8);
  const goals = pick(/\bgoal|deadline|milestone|plan\b/, 8);
  const constraints = pick(/\bnever|do not|can't|cannot|allergic|avoid\b/, 8);
  const correctionCount = all.filter((row) => /\bactually|correction|update\b/i.test(row)).length;
  const filledBuckets = [preferences, projects, goals, constraints].filter((bucket) => bucket.length > 0).length;
  return {
    identity: { workspace_id: POLICY_WORKSPACE_ID, container_tag: args.namespace },
    preferences,
    projects,
    goals,
    constraints,
    last_updated: new Date().toISOString(),
    confidence: Math.min(1, Math.max(0.1, (filledBuckets + Math.min(1, correctionCount)) / 4)),
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
    containerTag: z.string().max(128).optional(),
  },
}, async ({ query, top_k, includeProfile, containerTag }) => {
  const execStart = Date.now();
  const scope = getScopeForTool(containerTag);
  const decision = evaluatePolicy("recall", containerTag, { queryText: query, topK: top_k, includeProfile });
  if (decision.status === "deny") return denied("recall", decision, scope);
  const effectiveTopK = decision.appliedTopK ?? top_k;
  const sk = scopeCacheKey(containerTag);
  try {
    const key = cache.makeKey({
      tool: "recall",
      scope: sk,
      query: `${query}:${effectiveTopK}:${includeProfile ? 1 : 0}`,
      policyVersion: MCP_POLICY_VERSION,
    });
    const result = await cache.getOrCompute(key, { tool: "recall", scope: sk }, async () => {
      const rows = await searchRows(query, effectiveTopK, containerTag);
      const recent =
        includeProfile && decision.degradeLevel !== "disable_profile" ? await listRecent(5, containerTag) : [];
      const text = `${recent.length > 0 ? `## Profile (recent)\n${recent.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\n` : ""}## Recall\n${formatSearchResults(rows)}`;
      const confidence = rows.length > 0 ? Math.min(1, Math.max(0, (rows[0]?.score ?? 0) / 0.08)) : 0;
      const { namespace } = resolveStdioScope(containerTag);
      const profileEngine = buildProfileEngine({
        recentTexts: recent,
        historyTexts: rows.map((r) => r.text),
        namespace,
      });
      return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        status: confidence < 0.35 ? "low_confidence" : decision.status === "degrade" ? "degraded" : "ok",
        results: rows,
        profile_engine: profileEngine,
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
      sessionId: scope.sessionId,
      scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
    });
    policy.complete({ actionId: "recall", scope, nowMs: Date.now(), queryText: query, topK: effectiveTopK });
  }
});

server.registerTool("context", {
  description: "Generate structured context to improve model responses.",
  inputSchema: {
    query: z.string().min(1).max(2000),
    top_k: z.number().int().min(SEARCH_LIMIT_MIN).max(SEARCH_LIMIT_MAX).optional().default(SEARCH_LIMIT_DEFAULT),
    profile: z.enum(["balanced", "precision", "recall"]).optional().default("balanced"),
    containerTag: z.string().max(128).optional(),
  },
}, async ({ query, top_k, profile, containerTag }) => {
  const execStart = Date.now();
  const scope = getScopeForTool(containerTag);
  const decision = evaluatePolicy("context", containerTag, { queryText: query, topK: top_k });
  if (decision.status === "deny") return denied("context", decision, scope);
  const effectiveTopK = decision.appliedTopK ?? top_k;
  const sk = scopeCacheKey(containerTag);
  try {
    const key = cache.makeKey({
      tool: "context",
      scope: sk,
      query: `${query}:${effectiveTopK}:${profile}`,
      policyVersion: MCP_POLICY_VERSION,
    });
    const result = await cache.getOrCompute(key, { tool: "context", scope: sk }, async () => {
      const rows = await searchRows(query, effectiveTopK, containerTag);
      const recent =
        profile !== "precision" && decision.degradeLevel !== "disable_profile"
          ? await listRecent(8, containerTag)
          : [];
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
      const { namespace } = resolveStdioScope(containerTag);
      const profileEngine = buildProfileEngine({
        recentTexts: context.profileFacts,
        historyTexts: context.relevantHistory.map((row) => row.text),
        namespace,
      });
      return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        status: decision.status === "degrade" ? "degraded" : "ok",
        context: {
          profileFacts: context.profileFacts,
          relevantHistory: context.relevantHistory,
          guidance: context.guidance,
        },
        profile_engine: profileEngine,
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
      sessionId: scope.sessionId,
      scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
    });
    policy.complete({ actionId: "context", scope, nowMs: Date.now(), queryText: query, topK: effectiveTopK });
  }
});

server.registerTool("memory", {
  description: "Save or forget persistent memory for this workspace (MemoryNode).",
  inputSchema: {
    action: z.enum(["save", "forget", "confirm_forget"]).optional(),
    content: z.string().min(1).max(INSERT_CONTENT_MAX).optional(),
    metadata: z.record(z.unknown()).optional(),
    containerTag: z.string().max(128).optional(),
    confirm: z
      .object({
        token: z.string().optional(),
        memory_id: z.string().optional(),
      })
      .optional(),
    nonce: z.string().min(8).optional(),
    timestampMs: z.number().int().optional(),
  },
}, async ({ content, action, containerTag, confirm, nonce, timestampMs, metadata }) => {
  const execStart = Date.now();
  const act = action ?? "save";
  const scope = getScopeForTool(containerTag);
  const actionId: McpActionId =
    act === "forget" ? "memory.forget" : act === "confirm_forget" ? "memory.confirm_forget" : "memory.save";
  const decision = evaluatePolicy(actionId, containerTag, {
    contentText: content,
    nonce,
    timestampMs,
  });
  if (decision.status === "deny") return denied(actionId, decision, scope);
  const mustComplete = decision.status === "allow" || decision.status === "degrade";

  try {
    if (act === "confirm_forget") {
      const token = confirm?.token ?? "";
      const memoryIdHint = confirm?.memory_id ?? "";
      if (!token && !memoryIdHint) {
        return toolError("confirmation_required", "confirm_forget requires token or memory_id.");
      }
      if (token) {
        const tokenDecision = policy.consumeConfirmationToken(
          {
            actionId,
            scope,
            nowMs: Date.now(),
          },
          token,
          memoryIdHint || undefined,
        );
        if (tokenDecision.status === "deny") return denied(actionId, tokenDecision, scope);
      }
      const targetId = memoryIdHint || confirm?.memory_id;
      if (!targetId) {
        return toolError("confirmation_required", "No memory_id available for confirm_forget.");
      }
      const del = await restFetch(`/v1/memories/${encodeURIComponent(targetId)}`, { method: "DELETE" });
      if (!del.ok) {
        return toolError(
          "confirmation_required",
          `Delete failed: ${del.error ?? "unknown"}`,
        );
      }
      cache.invalidateScope(scopeCacheKey(containerTag));
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
      if (!content || !content.trim()) {
        return toolError("weak_signal", "content is required for save action.");
      }
      if (metadata !== undefined) {
        const str = JSON.stringify(metadata);
        if (str.length > METADATA_STRINGIFIED_MAX) {
          return toolError("invalid_request", "metadata stringified exceeds 5KB");
        }
      }
      const { user_id, namespace } = resolveStdioScope(containerTag);
      const out = await restFetch("/v1/memories", {
        method: "POST",
        body: {
          user_id,
          namespace,
          text: content,
          ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
        },
      });
      if (!out.ok) {
        return toolError("weak_signal", out.error ?? "Insert failed");
      }
      cache.invalidateScope(scopeCacheKey(containerTag));
      return {
        content: [{ type: "text" as const, text: "Saved to MemoryNode." }],
        structuredContent: {
          status: "saved",
          decision: { code: "OK", message: "saved" },
          data: { deduped: false, policy_version: MCP_POLICY_VERSION },
        },
      };
    }

    if (!content || !content.trim()) {
      return toolError("weak_signal", "content is required for forget action.");
    }
    const { user_id, namespace } = resolveStdioScope(containerTag);
    const search = await restFetch("/v1/search", {
      method: "POST",
      body: {
        user_id,
        namespace,
        query: content.slice(0, 2000),
        top_k: 3,
      },
    });
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
      const token = policy.issueConfirmationToken(
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
        content: [{ type: "text" as const, text: "Ambiguous forget request. Confirmation required." }],
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

    const del = await restFetch(`/v1/memories/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
    if (!del.ok) {
      return toolError("confirmation_required", `Delete failed: ${del.error ?? "unknown"}`);
    }
    cache.invalidateScope(scopeCacheKey(containerTag));
    return {
      content: [{ type: "text" as const, text: `Forgot memory ${memoryId}.` }],
      structuredContent: {
        status: "forgot",
        decision: { code: "OK", message: "deleted" },
        data: { memory_id: memoryId, policy_version: MCP_POLICY_VERSION },
      },
    };
  } catch (err) {
    const msg = parseErrorMessage(err, "Memory operation failed");
    return toolError("weak_signal", msg);
  } finally {
    policy.recordExecution({
      actionId,
      decision: decision.status,
      reason: decision.reasonCode,
      latencyMs: Date.now() - execStart,
      sessionId: scope.sessionId,
      scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
    });
    if (mustComplete) {
      policy.complete({
        actionId,
        scope,
        nowMs: Date.now(),
        contentText: content,
        nonce,
        timestampMs,
      });
    }
  }
});

server.registerTool("whoAmI", {
  description: "Identify current user scope and policy contract version.",
  outputSchema: {
    workspace_id: z.string(),
    user_id: z.string(),
    namespace: z.string(),
    container_tag: z.string(),
    session_id: z.string(),
    client: z.string(),
    policy_version: z.string(),
  },
}, async () => {
  const { user_id, namespace } = resolveStdioScope(null);
  const scopedTag = scopedContainerTagForIdentity();
  return {
    content: [],
    structuredContent: {
      status: "ok",
      identity: {
        workspace_id: POLICY_WORKSPACE_ID,
        user_id,
        namespace,
        container_tag: namespace,
        session_id: MCP_SESSION_ID,
        client: "memorynode-mcp-stdio",
        policy_version: MCP_POLICY_VERSION,
        ...(scopedTag ? { scoped_container_tag: scopedTag } : {}),
      },
    },
  };
});

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
  const scope = getScopeForTool(undefined);
  const decision = evaluatePolicy("memory.save", undefined, { contentText: content, nonce, timestampMs });
  if (decision.status === "deny") return denied("memory.save", decision, scope);
  try {
    if (metadata !== undefined) {
      const str = JSON.stringify(metadata);
      if (str.length > METADATA_STRINGIFIED_MAX) {
        return toolError("invalid_request", "metadata stringified exceeds 5KB");
      }
    }
    const { user_id, namespace } = resolveStdioScope(undefined);
    const out = await restFetch("/v1/memories", {
      method: "POST",
      body: {
        user_id,
        namespace,
        text: content,
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    });
    if (!out.ok) {
      return toolError("weak_signal", out.error ?? "Insert failed");
    }
    cache.invalidateScope(scopeCacheKey(undefined));
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
    policy.complete({ actionId: "memory.save", scope, nowMs: Date.now(), contentText: content, nonce, timestampMs });
  }
});

server.registerResource(
  "memory-search",
  new ResourceTemplate("memory://search{?q}", { list: undefined }),
  { description: "Semantic search over persistent memory. Use URI memory://search?q=..." },
  async (uri) => {
    const q = uri.searchParams.get("q");
    if (!q || !q.trim()) throw new Error(JSON.stringify({ code: "invalid_request", message: "Missing required query param: q" }));
    const rows = await searchRows(q, SEARCH_LIMIT_DEFAULT, undefined);
    const markdown = rows.map((r, i) => `## Result ${i + 1}\n**Score:** ${r.score.toFixed(2)}\n\n${r.text}\n`).join("\n");
    return { contents: [{ uri: uri.toString(), mimeType: "text/markdown", text: markdown }] };
  },
);

server.registerResource(
  "mn-profile",
  "memorynode://profile",
  {
    description: "Recent memories as a lightweight profile view.",
  },
  async () => {
    const { user_id, namespace } = resolveStdioScope(null);
    const list = await restFetch(
      `/v1/memories?user_id=${encodeURIComponent(user_id)}&namespace=${encodeURIComponent(namespace)}&page=1&page_size=${PROFILE_RESOURCE_PAGE_SIZE}`,
      { method: "GET" },
    );
    const results = Array.isArray((list.data as { results?: { text?: string; created_at?: string }[] })?.results)
      ? (list.data as { results: { text?: string; created_at?: string }[] }).results
      : [];
    const md =
      results.length === 0
        ? "_No memories yet for this scope._"
        : results.map((r, i) => `### ${i + 1}\n${typeof r.text === "string" ? r.text : ""}`).join("\n\n");
    return {
      contents: [{ uri: "memorynode://profile", mimeType: "text/markdown", text: md }],
    };
  },
);

server.registerResource(
  "mn-projects",
  "memorynode://projects",
  {
    description: "How project scoping maps to MemoryNode (stdio defaults from environment).",
  },
  async () => {
    const text = [
      "## MemoryNode project scope",
      "",
      "- Use environment variable **`MEMORYNODE_CONTAINER_TAG`** (or **`MEMORYNODE_NAMESPACE`**) as the default namespace.",
      `- **MEMORYNODE_USER_ID** sets the user slice (default **default**).`,
      "- Per-call **`containerTag`** on tools overrides the namespace when provided.",
      `- **MEMORYNODE_SCOPED_CONTAINER_TAG** pins the namespace (hosted **x-mn-container-tag** style) when set.`,
      `- Stdio policy labels: workspace **${POLICY_WORKSPACE_ID}** · session **${MCP_SESSION_ID}**.`,
      `- Policy contract version: **${MCP_POLICY_VERSION}**.`,
    ].join("\n");
    return {
      contents: [{ uri: "memorynode://projects", mimeType: "text/markdown", text }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
