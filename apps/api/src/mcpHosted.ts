/**
 * Hosted MCP (Streamable HTTP) on the API worker.
 * Tool surface: memory, recall, whoAmI; resources memorynode://profile, memorynode://projects; prompt context.
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

const MAX_SESSIONS = 2000;
/** In-process session map: entries older than this are expired and return 404 (best-effort; restarts clear all). */
const SESSION_TTL_MS = 60 * 60 * 1000;

/** Minimum normalized confidence required before MCP `forget` deletes the top search hit (semantic search is approximate). */
export const MIN_DELETE_CONFIDENCE = 0.75;
/** Maps fused RRF scores (~0.02–0.12 typical) into [0,1]; tune with {@link MIN_DELETE_CONFIDENCE}. */
const FUSED_SCORE_REFERENCE_MAX = 0.08;
/** Cap recall breadth from MCP (REST contract unchanged). */
const RECALL_TOP_K = 5;

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
    const namespace = sanitizeScopePart(containerTag ?? null, 128, defaultNamespace);
    const user_id = sanitizeScopePart(defaultUserId, 200, "default");
    return { user_id, namespace };
  };

  const server = new McpServer(
    { name: "memorynode-hosted-mcp", version: "1.0.0" },
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
        content: z.string().min(1).describe("Memory text to save, or text to match when forgetting."),
        action: z.enum(["save", "forget"]).optional().describe('Default "save". Use "forget" to remove the best-matching memory.'),
        containerTag: z.string().max(128).optional().describe("Optional scope tag; maps to MemoryNode namespace."),
      },
    },
    async ({ content, action, containerTag }) => {
      const act = action ?? "save";
      const { user_id, namespace } = resolveScope(containerTag);
      if (act === "save") {
        logger.info({
          event: "mcp_tool",
          tool: "memory",
          action: "save",
          userId: user_id,
          project: namespace,
          workspace_id: auth.workspaceId,
          request_id: requestId,
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
          return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: "Saved to MemoryNode." }] };
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
        return {
          content: [{ type: "text" as const, text: "Search failed while trying to forget." }],
          isError: true,
        };
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
          structuredContent: { success: false as const, reason: "no_match" as const },
        };
      }
      if (confidence < MIN_DELETE_CONFIDENCE) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Best match is below confidence threshold; nothing was deleted.",
            },
          ],
          structuredContent: { success: false as const, reason: "low_confidence_match" as const },
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
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
      return {
        content: [{ type: "text" as const, text: `Forgot memory ${memoryId}.` }],
        structuredContent: { success: true as const, id: memoryId },
      };
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
      },
    },
    async ({ query, includeProfile, containerTag }) => {
      const include = includeProfile !== false;
      const { user_id, namespace } = resolveScope(containerTag);
      logger.info({
        event: "mcp_tool",
        tool: "recall",
        userId: user_id,
        project: namespace,
        workspace_id: auth.workspaceId,
        request_id: requestId,
      });
      const out = await internalJson(
        env,
        restApiOrigin,
        apiKey,
        "POST",
        "/v1/search",
        { user_id, namespace, query, top_k: RECALL_TOP_K },
        requestId,
      );
      if (!out.ok) {
        const msg =
          typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
            ? (out.data as { error: { message: string } }).error.message
            : "Search failed";
        return { content: [{ type: "text" as const, text: msg }], isError: true };
      }
      const rawList = Array.isArray((out.data as { results?: unknown })?.results)
        ? (out.data as {
            results: Array<{
              memory_id?: string;
              chunk_id?: string;
              chunk_index?: number;
              text?: string;
              score?: number;
            }>;
          }).results
        : [];
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
      if (include) {
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
        profileBlock =
          recent.length === 0
            ? "_No recent rows for profile summary._"
            : recent.map((r, i) => `${i + 1}. ${typeof r.text === "string" ? r.text : ""}`).join("\n");
      }
      const textBody = include
        ? `## Profile (recent)\n${profileBlock}\n\n## Recall\n${formatSearchResults(out.data)}`
        : formatSearchResults(out.data);

      return {
        content: [{ type: "text" as const, text: textBody }],
        structuredContent: {
          results: resultsOut,
          profile: { recent: include ? profileBlock : "" },
          meta: {
            reasoning,
            confidence,
          },
        },
      };
    },
  );

  server.registerTool(
    "whoAmI",
    {
      description: "Return the active MemoryNode API identity for this MCP session.",
      outputSchema: {
        userId: z.string(),
        email: z.string(),
        name: z.string(),
        client: z.string(),
        sessionId: z.string(),
      },
    },
    async () => {
      const sessionId = getSessionId() ?? "";
      return {
        content: [],
        structuredContent: {
          userId: `${auth.workspaceId}:${defaultUserId}/${defaultNamespace}`,
          email: "",
          name: "",
          client: "memorynode-mcp-http",
          sessionId,
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
        "- Use HTTP header **`x-mn-project`** on the MCP URL (or tool argument **`containerTag`**) to set the MemoryNode **namespace** for this session.",
        `- Defaults for this connection: user slice **${defaultUserId}**, namespace **${defaultNamespace}**.`,
        "- API key determines the **workspace**; keep keys server-side.",
        `- Streamable HTTP sessions idle out after **~${Math.round(SESSION_TTL_MS / 60000)} minutes** (in-process map; deploy/restart clears sessions).`,
      ].join("\n");
      return {
        contents: [{ uri: "memorynode://projects", mimeType: "text/markdown", text }],
      };
    },
  );

  server.registerPrompt(
    "context",
    {
      description: "Starter context: recent memories + hints to use memory/recall tools.",
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
        "Use the **recall** tool to search stored facts before guessing. Use **memory** to save durable notes after the user agrees.",
        "",
        `Workspace: \`${auth.workspaceId}\` · user_id: \`${user_id}\` · namespace: \`${namespace}\``,
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

  const defaultUserId = sanitizeScopePart(request.headers.get("x-mn-user-id"), 200, "default");
  const defaultNamespace = sanitizeScopePart(request.headers.get("x-mn-project"), 128, "mcp");
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
  for (const [k, v] of Object.entries(ctx.securityHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}
