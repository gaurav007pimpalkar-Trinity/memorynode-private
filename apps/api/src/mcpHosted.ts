/**
 * Hosted MCP (Streamable HTTP) on the API worker.
 * Tool registration: `@memorynodeai/mcp-core` (`registerAllHostedTools`). Resources/prompts stay here.
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
import { enforceIsolation } from "./middleware/isolation.js";
import { hostedDirectListMemories, hostedDirectSearch } from "./services/hostedDirect.js";
import { resolveQuotaForWorkspace } from "./usage/quotaResolution.js";
import { McpResponseCache } from "./mcpCache.js";
import {
  createAliasBehavior,
  MCP_POLICY_VERSION,
  normalizeDeprecationPhase,
  registerAllHostedTools,
  TOOL_MANIFEST_VERSION,
  createHostedMcpPlanGate,
  type HostedBrandedDeps,
  type HostedDirectListMemoriesFn,
  type HostedDirectSearchFn,
} from "@memorynodeai/mcp-core";
import { McpPolicyEngine, type McpActionId, type PolicyInput, type PolicyScope } from "@memorynodeai/shared";

const MAX_SESSIONS = 2000;
/** In-process session map: entries older than this are expired and return 404 (best-effort; restarts clear all). */
const SESSION_TTL_MS = 60 * 60 * 1000;

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

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** True when this looks like a human opening the MCP URL in a browser tab (not curl / MCP clients). */
function isLikelyBrowserDocumentNavigation(request: Request): boolean {
  const dest = request.headers.get("Sec-Fetch-Dest");
  const mode = request.headers.get("Sec-Fetch-Mode");
  if (dest === "document" || mode === "navigate") return true;
  const accept = (request.headers.get("Accept") ?? "").toLowerCase();
  return accept.includes("text/html");
}

function safePublicAppBase(env: Env): string | null {
  const raw = (env.PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!raw) return null;
  try {
    new URL(raw);
    return raw;
  } catch {
    return null;
  }
}

function buildMcpBrowserLandingPage(request: Request, env: Env): string {
  const pageUrl = new URL(request.url);
  const canonicalMcp = `${pageUrl.origin}${pageUrl.pathname.replace(/\/$/, "") || "/mcp"}`;
  const restOrigin = resolveRestApiOrigin(request, env);
  const alternateMcp = `${restOrigin}/v1/mcp`;
  const consoleBase = safePublicAppBase(env);
  const consoleLink =
    consoleBase != null
      ? `<p><a href="${escapeHtmlText(consoleBase)}">Open MemoryNode</a> to create an API key and MCP setup.</p>`
      : "<p>Create a project API key in the MemoryNode console, then add this URL to your MCP client.</p>";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MemoryNode MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem;
      line-height: 1.5; color: #e8eaed; background: #0f1419; }
    a { color: #7cb8ff; }
    code { background: #1a222d; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9rem; word-break: break-all; }
    .box { background: #1a222d; border-radius: 8px; padding: 1rem 1.1rem; margin: 1rem 0; border: 1px solid #2a3444; }
  </style>
</head>
<body>
  <h1>MemoryNode MCP (HTTP)</h1>
  <p>This address is a <strong>machine endpoint</strong> for the Model Context Protocol. It is not a website to browse.</p>
  <p>Use it in an MCP-capable editor or agent (for example Cursor) with your <strong>project API key</strong> (<code>Authorization: Bearer …</code> or <code>x-api-key</code>). Opening it here without credentials only shows this page.</p>
  ${consoleLink}
  <div class="box">
    <p><strong>Hosted MCP URL (this host)</strong></p>
    <p><code>${escapeHtmlText(canonicalMcp)}</code></p>
    <p><strong>Same MCP on the API host</strong></p>
    <p><code>${escapeHtmlText(alternateMcp)}</code></p>
  </div>
  <p>Technical reference: <code>docs/MCP_SERVER.md</code> in the MemoryNode repository.</p>
</body>
</html>`;
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

function invalidateScopeCache(workspaceId: string, userId: string, namespace: string): void {
  mcpCache.invalidateScope(`${workspaceId}:${userId}:${namespace}`);
}

function createBrandedMcpServer(args: {
  env: Env;
  restApiOrigin: string;
  apiKey: string;
  auth: AuthContext;
  supabase: SupabaseClient;
  defaultUserId: string;
  defaultNamespace: string;
  requestId: string;
  getSessionId: () => string;
}): McpServer {
  const { env, restApiOrigin, apiKey, auth, supabase, defaultUserId, defaultNamespace, requestId, getSessionId } = args;

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
  const aliasBehavior = createAliasBehavior({
    deprecationPhase,
    logger: logger as unknown as { info: (payload: Record<string, unknown>) => void },
    auth,
    requestId,
  });

  const server = new McpServer(
    { name: "memorynode-hosted-mcp", version: "1.1.0" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  registerAllHostedTools(server, {
    env,
    restApiOrigin,
    apiKey,
    auth,
    defaultUserId,
    defaultNamespace,
    requestId,
    getSessionId,
    hostedPolicy,
    internalJson,
    hostedDirectSearch: (p: Parameters<HostedDirectSearchFn>[0]) =>
      hostedDirectSearch({
        auth,
        env,
        supabase,
        requestId,
        user_id: p.user_id,
        namespace: p.namespace,
        query: p.query,
        top_k: p.top_k,
      }),
    hostedDirectListMemories: (p: Parameters<HostedDirectListMemoriesFn>[0]) =>
      hostedDirectListMemories({
        auth,
        env,
        supabase,
        requestId,
        params: {
          page: p.page,
          page_size: p.page_size,
          namespace: p.namespace,
          user_id: p.user_id,
          owner_id: p.user_id,
          owner_type: "user",
          filters: {},
        },
      }),
    mcpCache,
    logger,
    MCP_POLICY_VERSION,
    TOOL_MANIFEST_VERSION,
    invalidateScopeCache,
    resolveScope,
    toPolicyScope,
    evaluateWithLog,
    aliasBehavior,
    planGate: createHostedMcpPlanGate(env),
  } as unknown as HostedBrandedDeps);

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

  if (
    method === "GET" &&
    !extractApiKey(request) &&
    !(request.headers.get("mcp-session-id") ?? "").trim() &&
    isLikelyBrowserDocumentNavigation(request)
  ) {
    const html = buildMcpBrowserLandingPage(request, env);
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        ...ctx.securityHeaders,
      },
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

  const isolationResolution = enforceIsolation(
    request,
    env,
    {
      userId: request.headers.get("x-mn-user-id"),
      scope: request.headers.get("x-mn-scope"),
      containerTag: request.headers.get("x-mn-container-tag"),
    },
    { scopedContainerTag: auth.scopedContainerTag ?? null },
  );
  if (isolationResolution.isolation.conflictDetected) {
    logger.info({
      event: "mcp_routing_conflict",
      request_id: requestId,
      workspace_id: auth.workspaceId,
      routing_mode: isolationResolution.isolation.routingMode,
    });
  }
  const defaultUserId = sanitizeScopePart(isolationResolution.isolation.ownerId, 128, "default");
  const defaultNamespace = sanitizeScopePart(isolationResolution.isolation.containerTag, 128, "default");
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
    for (const [k, v] of Object.entries(isolationResolution.responseHeaders)) {
      if (!headers.has(k)) headers.set(k, v);
    }
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
    supabase,
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
  for (const [k, v] of Object.entries(isolationResolution.responseHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  for (const [k, v] of Object.entries(ctx.securityHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}
