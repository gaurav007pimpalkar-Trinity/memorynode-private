/**
 * Hosted MCP (Streamable HTTP) on the API worker.
 * Tool surface: memory, recall, context, whoAmI; resources memorynode://profile, memorynode://projects; prompt context.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { z } from "zod";
import type { Env } from "./env.js";
import type { RequestContext } from "./cors.js";
import { authenticate, extractApiKey, rateLimit, rateLimitWorkspace, type AuthContext } from "./auth.js";
import { isApiError } from "./http.js";
import { getRouteRateLimitMax } from "./limits.js";
import { logger } from "./logger.js";
import { resolveQuotaForWorkspace } from "./usage/quotaResolution.js";
import { McpResponseCache } from "./mcpCache.js";
import {
  MCP_POLICY_VERSION,
  McpPolicyEngine,
  deriveContextSignals,
  policyDeniedError,
  normalizeDeprecationPhase,
  resolveAliasDecision,
  type McpActionId,
  type PolicyDecision,
  type PolicyInput,
  type PolicyScope,
} from "@memorynodeai/shared";

const MAX_SESSIONS = 2000;
/** In-process session map: entries older than this are expired and return 404 (best-effort; restarts clear all). */
const SESSION_TTL_MS = 60 * 60 * 1000;

/** Minimum normalized confidence required before MCP `forget` deletes the top search hit (semantic search is approximate). */
export const MIN_DELETE_CONFIDENCE = 0.75;
/** Maps fused RRF scores (~0.02–0.12 typical) into [0,1]; tune with {@link MIN_DELETE_CONFIDENCE}. */
const FUSED_SCORE_REFERENCE_MAX = 0.08;
/** Cap recall breadth from MCP (REST contract unchanged). */
const RECALL_TOP_K = 5;
const CONTEXT_BUDGET_CHARS = 2500;
const CONTEXT_SECTION_PROFILE_RATIO = 0.3;
const CONTEXT_SECTION_HISTORY_RATIO = 0.55;
const hostedPolicy = new McpPolicyEngine(undefined, {
  beforePolicy: (input) => {
    logger.info({
      event: "mcp_policy_before",
      tool: input.actionId,
      session_id: input.scope.sessionId,
      policy_version: MCP_POLICY_VERSION,
    });
  },
  afterPolicy: (input, decision, latencyMs) => {
    logger.info({
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
    });
  },
  afterExecution: (args) => {
    logger.info({
      event: "mcp_tool_execution",
      tool: args.actionId,
      decision: args.decision,
      reason: args.reason ?? null,
      latency_ms: args.latencyMs,
      session_id: args.sessionId,
      policy_version: MCP_POLICY_VERSION,
      scores: {
        similarity: args.scores?.similarity ?? null,
        novelty: args.scores?.novelty ?? null,
      },
    });
  },
});
const mcpCache = new McpResponseCache({
  maxSize: 400,
  ttlByTool: {
    recall: 15_000,
    context: 8_000,
  },
});

type SessionRecord = {
  transport: WebStandardStreamableHTTPServerTransport;
  mcp: McpServer;
  apiKey: string;
  auth: AuthContext;
  defaultUserId: string;
  defaultNamespace: string;
  lastTouch: number;
};

const sessions = new Map<string, SessionRecord>();

function touchSession(sid: string, rec: SessionRecord): void {
  rec.lastTouch = Date.now();
  sessions.set(sid, rec);
}

function evictIfNeeded(): void {
  if (sessions.size <= MAX_SESSIONS) return;
  const entries = [...sessions.entries()].sort((a, b) => a[1].lastTouch - b[1].lastTouch);
  const drop = Math.max(1, entries.length - MAX_SESSIONS + 100);
  for (let i = 0; i < drop; i++) {
    const sid = entries[i]?.[0];
    if (!sid) break;
    const rec = sessions.get(sid);
    sessions.delete(sid);
    void rec?.transport.close().catch(() => {});
  }
}

function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function sanitizeScopePart(raw: string | null, max: number, fallback: string): string {
  if (!raw || !raw.trim()) return fallback;
  const t = raw.trim().slice(0, max);
  const cleaned = t.replace(/[^-a-zA-Z0-9_.:]/g, "_");
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Public REST base for subrequests from hosted MCP (MCP may live on mcp.* while /v1/* stays on api.*). */
export function resolveRestApiOrigin(request: Request, env: Env): string {
  const fromEnv = (env.MEMORYNODE_REST_ORIGIN ?? "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;

  const u = new URL(request.url);
  const host = u.hostname.toLowerCase();
  if (host === "mcp.memorynode.ai") {
    return `${u.protocol}//api.memorynode.ai`;
  }
  return `${u.protocol}//${u.host}`;
}

/** Hosted Streamable MCP: canonical on mcp host as `/mcp`, also `/v1/mcp` on API host. */
export function isHostedMcpPath(pathname: string): boolean {
  return pathname === "/v1/mcp" || pathname === "/mcp";
}

async function internalJson(
  env: Env,
  origin: string,
  apiKey: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  requestId?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "x-internal-mcp": "true",
    "x-mcp-policy-version": MCP_POLICY_VERSION,
  };
  if (typeof env.MCP_INTERNAL_SECRET === "string" && env.MCP_INTERNAL_SECRET.length > 0) {
    headers["x-internal-secret"] = env.MCP_INTERNAL_SECRET;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (requestId) headers["X-Request-Id"] = requestId;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

function normalizedConfidenceFromFusionScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score / FUSED_SCORE_REFERENCE_MAX));
}

function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function extractQueryKeywords(q: string, max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of q.toLowerCase().split(/[^a-z0-9]+/)) {
    const w = raw.trim();
    if (w.length < 2) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

function buildRecallReasoning(query: string, rows: Array<{ text?: string }>): string[] {
  const lines: string[] = [];
  const keywords = extractQueryKeywords(query);
  if (keywords.length > 0 && rows.length > 0) {
    const blob = rows.map((r) => (typeof r.text === "string" ? r.text : "")).join(" ").toLowerCase();
    const hits = keywords.filter((k) => blob.includes(k));
    if (hits.length > 0) {
      lines.push(`Matches query keywords: ${hits.slice(0, 8).join(", ")}`);
    }
  }
  const sample = `${query} ${rows.map((r) => r.text).join(" ")}`.toLowerCase();
  if (/\bmcp\b|memorynode|hosted mcp/.test(sample)) {
    lines.push("Recent interaction related to MCP");
  }
  if (sample.includes("preference") || sample.includes("prefer ")) {
    lines.push("User preference match (lexical cue in retrieved text)");
  }
  if (lines.length === 0 && rows.length > 0) {
    lines.push("Ranked by hybrid semantic + lexical relevance for this workspace scope");
  }
  return lines;
}

function formatSearchResults(data: unknown): string {
  const results = Array.isArray((data as { results?: unknown })?.results)
    ? (data as {
        results: Array<{ text?: string; score?: number; memory_id?: string; id?: string }>;
      }).results
    : [];
  if (results.length === 0) return "No memories found.";
  return results
    .map((r, i) => {
      const score = typeof r.score === "number" ? r.score.toFixed(2) : "—";
      const id =
        typeof r.memory_id === "string"
          ? r.memory_id
          : typeof r.id === "string"
            ? r.id
            : "";
      const text = typeof r.text === "string" ? r.text : "";
      return `### ${i + 1}${id ? ` (memory_id: ${id})` : ""}\n**Score:** ${score}\n\n${text}\n`;
    })
    .join("\n");
}

function formatDeniedForTool(actionId: McpActionId, scope: PolicyScope, decision: PolicyDecision) {
  const denied = policyDeniedError({
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
  return {
    content: [{ type: "text" as const, text: denied.error.message }],
    structuredContent: denied,
    isError: true,
  };
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

function readRows(data: unknown): Array<{ memory_id?: string; id?: string; text?: string; score?: number; created_at?: string }> {
  return Array.isArray((data as { results?: unknown })?.results)
    ? (data as {
        results: Array<{ memory_id?: string; id?: string; text?: string; score?: number; created_at?: string }>;
      }).results
    : [];
}

function recencyScore(createdAt?: string): number {
  if (!createdAt) return 0.5;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0.5;
  const ageHours = Math.max(0, (Date.now() - t) / 3_600_000);
  return 1 / (1 + ageHours / 24);
}

function buildContextPayload(args: {
  query: string;
  searchRows: Array<{ memory_id?: string; text?: string; score?: number; created_at?: string }>;
  recentRows: Array<{ text?: string; created_at?: string }>;
}): {
  profileFacts: string[];
  relevantHistory: Array<{ memory_id: string; text: string; score: number }>;
  guidance: string[];
} {
  const seen = new Set<string>();
  const relevant = args.searchRows
    .map((r) => ({
      memory_id: typeof r.memory_id === "string" ? r.memory_id : "",
      text: typeof r.text === "string" ? r.text : "",
      score: typeof r.score === "number" ? r.score : 0,
      created_at: r.created_at,
    }))
    .filter((r) => r.text.length > 0)
    .map((r) => {
      const blended = r.score * 0.8 + recencyScore(r.created_at) * 0.2;
      return { ...r, blended };
    })
    .sort((a, b) => b.blended - a.blended)
    .filter((r) => {
      const k = normalizeForDedupe(r.text);
      if (k.length === 0 || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => ({ memory_id: r.memory_id, text: r.text, score: r.score }));

  const profileFacts = args.recentRows
    .map((r) => (typeof r.text === "string" ? r.text : ""))
    .filter((t) => t.length > 0)
    .map((t) => t.trim())
    .slice(0, 8);

  const guidance = [
    "Use recalled facts directly when confidence is high.",
    "If confidence is low, ask a clarifying question before assuming.",
    `Query intent: ${args.query.trim().slice(0, 200)}`,
  ];

  return { profileFacts, relevantHistory: relevant, guidance };
}

function truncateContextSections(context: {
  profileFacts: string[];
  relevantHistory: Array<{ memory_id: string; text: string; score: number }>;
  guidance: string[];
}): {
  profileFacts: string[];
  relevantHistory: Array<{ memory_id: string; text: string; score: number }>;
  guidance: string[];
  usedChars: number;
  truncated: boolean;
  steps: string[];
} {
  const profileBudget = Math.floor(CONTEXT_BUDGET_CHARS * CONTEXT_SECTION_PROFILE_RATIO);
  const historyBudget = Math.floor(CONTEXT_BUDGET_CHARS * CONTEXT_SECTION_HISTORY_RATIO);
  const guidanceBudget = Math.max(120, CONTEXT_BUDGET_CHARS - profileBudget - historyBudget);
  const steps: string[] = [];

  const trimList = (items: string[], budget: number, step: string): string[] => {
    const out: string[] = [];
    let used = 0;
    for (const item of items) {
      if (used + item.length > budget) {
        steps.push(step);
        break;
      }
      out.push(item);
      used += item.length;
    }
    return out;
  };

  const profileFacts = trimList(context.profileFacts, profileBudget, "profile_trimmed");
  const guidance = trimList(context.guidance, guidanceBudget, "guidance_trimmed");
  const relevantHistory: Array<{ memory_id: string; text: string; score: number }> = [];
  let historyUsed = 0;
  for (const row of context.relevantHistory) {
    if (historyUsed + row.text.length > historyBudget) {
      steps.push("history_tail_dropped");
      break;
    }
    relevantHistory.push(row);
    historyUsed += row.text.length;
  }

  const usedChars =
    profileFacts.reduce((n, x) => n + x.length, 0) +
    guidance.reduce((n, x) => n + x.length, 0) +
    relevantHistory.reduce((n, x) => n + x.text.length, 0);
  return {
    profileFacts,
    relevantHistory,
    guidance,
    usedChars,
    truncated: steps.length > 0,
    steps,
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

function buildProfileEngine(args: {
  workspaceId: string;
  containerTag: string;
  recentTexts: string[];
  historyTexts: string[];
}): ProfileEngineView {
  const all = [...args.recentTexts, ...args.historyTexts].map((x) => x.trim()).filter((x) => x.length > 0);
  const pick = (matcher: RegExp, limit: number): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const ordered = [...all].reverse();
    for (const row of ordered) {
      if (!matcher.test(row.toLowerCase())) continue;
      const key = normalizeForDedupe(row);
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
  // Correction-aware confidence: explicit corrections get priority in confidence math.
  const correctionCount = all.filter((row) => /\bactually|correction|update\b/i.test(row)).length;
  const filledBuckets = [preferences, projects, goals, constraints].filter((bucket) => bucket.length > 0).length;
  const confidence = Math.min(1, Math.max(0.1, (filledBuckets + Math.min(1, correctionCount)) / 4));
  return {
    identity: { workspace_id: args.workspaceId, container_tag: args.containerTag },
    preferences,
    projects,
    goals,
    constraints,
    last_updated: new Date().toISOString(),
    confidence,
  };
}

function invalidateScopeCache(workspaceId: string, userId: string, namespace: string): void {
  mcpCache.invalidateScope(`${workspaceId}:${userId}:${namespace}`);
}

function createBrandedMcpServer(args: {
  env: Env;
  restApiOrigin: string;
  apiKey: string;
  auth: AuthContext;
  defaultUserId: string;
  defaultNamespace: string;
  requestId: string;
  getSessionId: () => string;
}): McpServer {
  const { env, restApiOrigin, apiKey, auth, defaultUserId, defaultNamespace, requestId, getSessionId } = args;

  const resolveScope = (containerTag?: string | null) => {
    let namespace = sanitizeScopePart(containerTag ?? null, 128, defaultNamespace);
    const user_id = "default";
    const scopedTag = sanitizeScopePart(auth.scopedContainerTag ?? null, 128, "");
    if (scopedTag) namespace = scopedTag;
    return { user_id, namespace };
  };
  const toPolicyScope = (scope: { user_id: string; namespace: string }): PolicyScope => ({
    workspaceId: auth.workspaceId,
    keyId: auth.apiKeyId ?? auth.keyHash,
    userId: scope.user_id,
    namespace: scope.namespace,
    sessionId: getSessionId() || "no-session",
  });
  const evaluate = (actionId: McpActionId, input: Omit<PolicyInput, "actionId" | "scope" | "nowMs"> & { scope: PolicyScope }) =>
    hostedPolicy.evaluate({
      actionId,
      scope: input.scope,
      nowMs: Date.now(),
      queryText: input.queryText,
      contentText: input.contentText,
      topK: input.topK,
      nonce: input.nonce,
      timestampMs: input.timestampMs,
    });
  const evaluateWithLog = (
    actionId: McpActionId,
    input: Omit<PolicyInput, "actionId" | "scope" | "nowMs"> & { scope: PolicyScope },
  ) => {
    const decision = evaluate(actionId, input);
    logger.info({
      event: "mcp_policy_decision",
      action_id: actionId,
      decision: decision.status,
      reason_code: decision.reasonCode ?? null,
      decision_id: decision.decisionId,
      policy_version: MCP_POLICY_VERSION,
      workspace_id: input.scope.workspaceId,
      namespace: input.scope.namespace,
      user_id: input.scope.userId,
    });
    return decision;
  };
  const deprecationPhase = normalizeDeprecationPhase(
    (env as Env & { MCP_DEPRECATION_PHASE?: string }).MCP_DEPRECATION_PHASE,
  );
  const aliasBehavior = (alias: string, canonical: string) => {
    logger.info({
      event: "mcp_alias_usage",
      alias,
      canonical,
      phase: deprecationPhase,
      workspace_id: auth.workspaceId,
      request_id: requestId,
    });
    const decision = resolveAliasDecision(deprecationPhase, canonical);
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
  };

  const server = new McpServer(
    { name: "memorynode-hosted-mcp", version: "1.1.0" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  server.registerTool(
    "memory",
    {
      description: "Save or forget persistent memory for this workspace (MemoryNode).",
      inputSchema: {
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
      },
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
      // forget: retrieve top candidates; semantic search is approximate — threshold prevents accidental deletion.
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
    "recall",
    {
      description: "Semantic search over MemoryNode memories; optional short profile summary.",
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
        tool: "recall",
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
          const out = await internalJson(
        env,
        restApiOrigin,
        apiKey,
        "POST",
        "/v1/search",
        { user_id, namespace, query, top_k: effectiveTopK },
        requestId,
      );
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
        const list = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "GET",
          `/v1/memories?user_id=${encodeURIComponent(user_id)}&namespace=${encodeURIComponent(namespace)}&page=1&page_size=5`,
          undefined,
          requestId,
        );
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

  server.registerTool(
    "context",
    {
      description: "Generate bounded structured context for model responses.",
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
          const search = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "POST",
          "/v1/search",
          { user_id, namespace, query, top_k: effectiveTopK },
          requestId,
        );
        if (!search.ok) {
          return toolError("cost_exceeded", "Search failed for context.");
        }
        const includeProfile = decision.degradeLevel !== "disable_profile" && profile !== "precision";
        const list = includeProfile
          ? await internalJson(
              env,
              restApiOrigin,
              apiKey,
              "GET",
              `/v1/memories?user_id=${encodeURIComponent(user_id)}&namespace=${encodeURIComponent(namespace)}&page=1&page_size=8`,
              undefined,
              requestId,
            )
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

  // alias compatibility
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
      const alias = aliasBehavior("memory_search", "recall");
      if (alias.blocked) return alias.response;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const decision = evaluateWithLog("recall", { scope, queryText: query, topK: limit ?? RECALL_TOP_K });
      if (decision.status === "deny") return formatDeniedForTool("recall", scope, decision);
      const out = await internalJson(
        env,
        restApiOrigin,
        apiKey,
        "POST",
        "/v1/search",
        { user_id, namespace, query, top_k: decision.appliedTopK ?? limit ?? RECALL_TOP_K },
        requestId,
      );
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
        const search = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "POST",
          "/v1/search",
          { user_id, namespace, query, top_k: decision.appliedTopK ?? limit ?? RECALL_TOP_K },
          requestId,
        );
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

  server.registerResource(
    "mn-profile",
    "memorynode://profile",
    {
      description: "Recent memories as a lightweight profile view.",
    },
    async () => {
      const { user_id, namespace } = resolveScope(null);
      const list = await internalJson(
        env,
        restApiOrigin,
        apiKey,
        "GET",
        `/v1/memories?user_id=${encodeURIComponent(user_id)}&namespace=${encodeURIComponent(namespace)}&page=1&page_size=15`,
        undefined,
        requestId,
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
      description: "How project scoping maps to MemoryNode.",
    },
    async () => {
      const text = [
        "## MemoryNode project scope",
        "",
        "- Use HTTP header **`x-mn-container-tag`** on the MCP URL (or tool argument **`containerTag`**) to set the MemoryNode **namespace** for this session.",
        `- Defaults for this connection: user slice **${defaultUserId}**, namespace **${defaultNamespace}**.`,
        "- API key determines the **workspace**; keep keys server-side.",
        `- Streamable HTTP sessions idle out after **~${Math.round(SESSION_TTL_MS / 60000)} minutes** (in-process map; deploy/restart clears sessions).`,
        `- Policy contract version: **${MCP_POLICY_VERSION}**.`,
      ].join("\n");
      return {
        contents: [{ uri: "memorynode://projects", mimeType: "text/markdown", text }],
      };
    },
  );

  server.registerPrompt(
    "context",
    {
      description: "Starter context: use context/recall first, memory for confirmed durable facts.",
      argsSchema: {
        containerTag: z.string().max(128).optional(),
        includeRecent: z.boolean().optional(),
      },
    },
    async (args) => {
      const includeRecent = args.includeRecent !== false;
      const { user_id, namespace } = resolveScope(args.containerTag ?? null);
      let recent = "";
      if (includeRecent) {
        const list = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "GET",
          `/v1/memories?user_id=${encodeURIComponent(user_id)}&namespace=${encodeURIComponent(namespace)}&page=1&page_size=8`,
          undefined,
          requestId,
        );
        const results = Array.isArray((list.data as { results?: { text?: string }[] })?.results)
          ? (list.data as { results: { text?: string }[] }).results
          : [];
        recent =
          results.length === 0
            ? "(No recent memories.)"
            : results.map((r, i) => `${i + 1}. ${typeof r.text === "string" ? r.text : ""}`).join("\n");
      }
      const body = [
        "You are connected to **MemoryNode** (hosted MCP).",
        "",
        "Use **context** before responding when memory may matter. Use **recall** for focused lookups. Use **memory** to store durable, user-confirmed facts only.",
        "",
        `Workspace: \`${auth.workspaceId}\` · user_id: \`${user_id}\` · namespace: \`${namespace}\``,
        `Policy version: \`${MCP_POLICY_VERSION}\``,
        "",
        "## Recent activity",
        recent,
      ].join("\n");
      return {
        messages: [{ role: "user", content: { type: "text", text: body } }],
      };
    },
  );

  return server;
}

function jsonRpcError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** Same entitlement + per-key + per-workspace RPM gates as `/v1/search`; returns a Response when blocked. */
async function applyMcpEntitlementAndRateLimits(
  env: Env,
  supabase: SupabaseClient,
  auth: AuthContext,
  ctx: RequestContext,
): Promise<Response | null> {
  const quota = await resolveQuotaForWorkspace(auth, supabase);
  if (quota.blocked) {
    const body = {
      error: {
        code: quota.errorCode ?? "ENTITLEMENT_EXPIRED",
        message:
          quota.message ??
          "Active entitlement expired. Renew to continue quota-consuming API calls.",
        upgrade_required: true,
        effective_plan: "launch",
        ...(quota.expiredAt != null && { expired_at: quota.expiredAt }),
      },
      upgrade_url: env.PUBLIC_APP_URL ? `${env.PUBLIC_APP_URL}/billing` : undefined,
    };
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: { "Content-Type": "application/json", ...ctx.securityHeaders },
    });
  }
  const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "search", auth.keyCreatedAt));
  if (!rate.allowed) {
    return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Rate limit exceeded" } }), {
      status: 429,
      headers: { "Content-Type": "application/json", ...rate.headers, ...ctx.securityHeaders },
    });
  }
  const wsRpm = quota.planLimits.workspace_rpm ?? 120;
  const wsRate = await rateLimitWorkspace(auth.workspaceId, wsRpm, env);
  if (!wsRate.allowed) {
    return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Workspace rate limit exceeded" } }), {
      status: 429,
      headers: { "Content-Type": "application/json", ...rate.headers, ...wsRate.headers, ...ctx.securityHeaders },
    });
  }
  return null;
}

export async function handleHostedMcpRequest(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  ctx: RequestContext,
  requestId: string,
  auditCtx: { workspaceId?: string; apiKeyId?: string },
): Promise<Response> {
  const pathname = new URL(request.url).pathname.replace(/\/$/, "") || "/";
  if (!isHostedMcpPath(pathname)) {
    return jsonRpcError(404, "Not found");
  }

  const method = request.method.toUpperCase();
  if (!["GET", "POST", "DELETE"].includes(method)) {
    return new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }), {
      status: 405,
      headers: { Allow: "GET, POST, DELETE", "Content-Type": "application/json", ...ctx.securityHeaders },
    });
  }

  let auth: AuthContext;
  try {
    auth = await authenticate(request, env, supabase, auditCtx);
    auditCtx.workspaceId = auth.workspaceId;
    if (auth.apiKeyId) auditCtx.apiKeyId = auth.apiKeyId;
  } catch (e: unknown) {
    const status = isApiError(e) ? (e.status ?? 401) : 401;
    const code = isApiError(e) ? e.code : "UNAUTHORIZED";
    const msg = isApiError(e) ? e.message : "Unauthorized";
    return new Response(JSON.stringify({ error: { code, message: msg } }), {
      status,
      headers: { "Content-Type": "application/json", ...ctx.securityHeaders },
    });
  }

  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Bearer or x-api-key required" } }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...ctx.securityHeaders },
    });
  }

  const gated = await applyMcpEntitlementAndRateLimits(env, supabase, auth, ctx);
  if (gated) return gated;

  const defaultUserId = "default";
  const defaultNamespace = sanitizeScopePart(request.headers.get("x-mn-container-tag"), 128, "default");
  const restApiOrigin = resolveRestApiOrigin(request, env);

  const sessionHeader = request.headers.get("mcp-session-id");
  if (sessionHeader) {
    const rec = sessions.get(sessionHeader);
    if (!rec) {
      return jsonRpcError(404, "Session not found");
    }
    if (Date.now() - rec.lastTouch > SESSION_TTL_MS) {
      sessions.delete(sessionHeader);
      void rec.transport.close().catch(() => {});
      return jsonRpcError(404, "Session expired");
    }
    if (!timingSafeEqualString(rec.apiKey, apiKey)) {
      return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "API key mismatch for session" } }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...ctx.securityHeaders },
      });
    }
    touchSession(sessionHeader, rec);
    let parsedBody: unknown = undefined;
    if (method === "POST") {
      try {
        parsedBody = await request.json();
      } catch {
        return jsonRpcError(400, "Invalid JSON body");
      }
    }
    const res = await rec.transport.handleRequest(request, { parsedBody });
    const headers = new Headers(res.headers);
    headers.set("x-mcp-policy-version", MCP_POLICY_VERSION);
    for (const [k, v] of Object.entries(ctx.securityHeaders)) {
      if (!headers.has(k)) headers.set(k, v);
    }
    return new Response(res.body, { status: res.status, headers });
  }

  if (method !== "POST") {
    return jsonRpcError(400, "Bad Request: initialization must be POST");
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return jsonRpcError(400, "Invalid JSON body");
  }

  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  if (!messages.some(isInitializeRequest)) {
    return jsonRpcError(400, "Bad Request: No valid session ID provided");
  }

  evictIfNeeded();

  const bag: { transport?: WebStandardStreamableHTTPServerTransport } = {};
  const mcp = createBrandedMcpServer({
    env,
    restApiOrigin,
    apiKey,
    auth,
    defaultUserId,
    defaultNamespace,
    requestId,
    getSessionId: () => bag.transport?.sessionId ?? "",
  });

  bag.transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sid) => {
      const tr = bag.transport;
      if (!tr) return;
      sessions.set(sid, {
        transport: tr,
        mcp,
        apiKey,
        auth,
        defaultUserId,
        defaultNamespace,
        lastTouch: Date.now(),
      });
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
    },
  });

  const tr = bag.transport;
  tr.onclose = () => {
    const sid = tr.sessionId;
    if (sid) sessions.delete(sid);
  };

  await mcp.connect(tr);

  const res = await tr.handleRequest(request, { parsedBody });

  const headers = new Headers(res.headers);
  headers.set("x-mcp-policy-version", MCP_POLICY_VERSION);
  for (const [k, v] of Object.entries(ctx.securityHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}
