import type { SupabaseClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import {
  capsByPlanCode,
  exceedsCaps,
  getRateLimitMax,
  getRouteRateLimitMax,
  type UsageSnapshot,
} from "./limits.js";
import {
  COST_MODEL_VERSION,
  computeInternalCredits,
  type PlanLimits,
} from "@memorynodeai/shared";
import type { Env } from "./env.js";
import {
  getEnvironmentStage,
  isRlsFirstAccessMode,
  isServiceRoleRequestPathDisabled,
  validateStubModes,
  validateRateLimitConfig,
  validateSecrets,
} from "./env.js";
import { logger, redact } from "./logger.js";
import { route, type HandlerDeps } from "./router.js";
import { createHttpError, isApiError } from "./http.js";
import { checkGlobalCostGuard, AIBudgetExceededError } from "./costGuard.js";
import {
  type RequestContext,
  buildResponseHeaders,
  buildSecurityHeaders,
  parseAllowedOrigins,
  isOriginAllowed,
  makeCorsHeaders,
  resolveRequestId,
  runInRequestScope,
} from "./cors.js";
import {
  rateLimit,
  rateLimitWorkspace,
  requireAdmin,
  type AuthContext,
  normalizePlanStatus,
  getApiKeySalt,
  hashApiKey,
} from "./auth.js";
import { emitAuditLog } from "./audit.js";
import {
  createMemoryHandlers,
  type MemoryHandlerDeps,
} from "./handlers/memories.js";
import {
  createSearchHandlers,
  type SearchHandlerDeps,
} from "./handlers/search.js";
import { createContextHandlers } from "./handlers/context.js";
import { createContextExplainHandlers } from "./handlers/contextExplain.js";
import { createUsageHandlers, type UsageHandlerDeps } from "./handlers/usage.js";
import { createAuditLogHandlers, type AuditLogHandlerDeps } from "./handlers/auditLog.js";
import { createDashboardOverviewHandlers } from "./handlers/dashboardOverview.js";
import { createBillingHandlers, type BillingHandlerDeps } from "./handlers/billing.js";
import { createWebhookHandlers, type WebhookHandlerDeps } from "./handlers/webhooks.js";
import { createAdminHandlers, type AdminHandlerDeps } from "./handlers/admin.js";
import { createImportHandlers, type ImportHandlerDeps, type ImportMode } from "./handlers/import.js";
import { createConnectorSettingsHandlers } from "./handlers/connectorSettings.js";
import { createWorkspacesHandlers, type WorkspacesHandlerDeps } from "./handlers/workspaces.js";
import { createApiKeysHandlers, type ApiKeysHandlerDeps } from "./handlers/apiKeys.js";
import { createEvalHandlers, type EvalHandlerDeps } from "./handlers/evals.js";
import { createPruningHandlers } from "./handlers/pruning.js";
import { createExplainHandlers } from "./handlers/explain.js";
import {
  createDashboardSession,
  deleteDashboardSession,
  getDashboardSession,
  validateDashboardCsrf,
  verifySupabaseAccessToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  SESSION_TTL_SEC,
} from "./dashboardSession.js";
import { withSupabaseQueryRetry } from "./supabaseRetry.js";
import {
  RETRY_MAX_ATTEMPTS,
  SUPABASE_RETRY_DELAYS_MS,
  OPENAI_EMBED_RETRY_DELAYS_MS,
  EMBED_REQUEST_TIMEOUT_MS,
} from "./resilienceConstants.js";
import { withCircuitBreaker } from "./circuitBreaker.js";
import { assertRowsWorkspaceScoped } from "./supabaseScoped.js";
import {
  createAnonSupabaseClient,
  createRequestScopedSupabaseClient,
  createServiceRoleSupabaseClient,
} from "./dbClientFactory.js";
import { chunkParamsForProfile, type ChunkProfile } from "./contracts/memories.js";
import {
  buildPayURequestHashInput,
  computeSha512Hex,
} from "./billing/payuHash.js";
import { resolveEntitlementPlanCode } from "./billing/entitlements.js";
import type { EffectivePlanCode } from "./billing/entitlements.js";
export type { EffectivePlanCode } from "./billing/entitlements.js";
import {
  assertPayUEnvFor,
  asNonEmptyString,
  createPayUWebhookReconciler,
  DEFAULT_PAYU_PRODUCT_INFO,
  DEFAULT_WEBHOOK_REPROCESS_LIMIT,
  fetchPayUTransactionByTxnId,
  formatAmountStrict,
  isPayUBillingConfigured,
  isPayUWebhookSignatureValid,
  normalizeCurrency,
  normalizePayUBaseUrl,
  parseWebhookPayload,
  resolvePayUAmountForPlan,
  resolvePayUEventCreated,
  resolvePayUEventId,
  resolvePayUEventType,
  resolvePayUVerifyTimeoutMs,
  resolveProductInfoForPlan,
  transitionPayUTransactionStatus,
} from "./billing/payuReconcile.js";
import {
  buildUpgradeUrl,
  planLimitExceededResponse,
  reserveQuotaAndMaybeRespond,
  markUsageReservationCommitted,
  markUsageReservationRefundPending,
  estimateRequestCostInr,
} from "./usage/quotaReservation.js";
import { resolveQuotaForWorkspace } from "./usage/quotaResolution.js";
import { handleHostedMcpRequest, isHostedMcpPath } from "./mcpHosted.js";
import type { SearchPayload } from "./contracts/search.js";
import type { MetadataFilter } from "./search/normalizeRequest.js";
import { normalizeSearchPayload, normalizeMemoryListParams } from "./search/normalizeRequest.js";
import type { MemoryListParams } from "./handlers/memories.js";

function parseApiKeyMeta(raw: string): { prefix: string; last4: string } {
  const parts = raw.split("_");
  if (parts.length >= 3) {
    return {
      prefix: parts.slice(0, 2).join("_"),
      last4: raw.slice(-4),
    };
  }
  return { prefix: "", last4: raw.slice(-4) };
}

const SEARCH_MATCH_COUNT = 200;
const MAX_FUSE_RESULTS = 200;
const DEFAULT_MAX_BODY_BYTES = 1_000_000; // 1 MB
const DEFAULT_MAX_IMPORT_BYTES = 10_000_000; // 10 MB
const DEFAULT_MAX_EXPORT_BYTES = 10_000_000; // 10 MB
const MEMORIES_MAX_BODY_BYTES = 1_000_000; // 1 MB for ingest
const SEARCH_MAX_BODY_BYTES = 200_000; // 200 KB for search/context
const ADMIN_MAX_BODY_BYTES = 100_000; // 100 KB for admin/control plane ops
const RRF_K = 60;
const DEFAULT_SUCCESS_PATH = "/settings/billing?status=success";
const DEFAULT_CANCEL_PATH = "/settings/billing?status=canceled";

type ProductEventContext = {
  workspaceId?: string | null;
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  effectivePlan?: EffectivePlanCode | AuthContext["plan"];
  planStatus?: AuthContext["planStatus"];
};

type FounderMetricsRange = "24h" | "7d" | "30d";

function emitEventLog(event_name: string, fields: Record<string, unknown>): void {
  logger.info({
    event: event_name,
    ...fields,
  });
}

async function emitProductEvent(
  supabase: SupabaseClient,
  eventName: string,
  ctx: ProductEventContext,
  props: Record<string, unknown> = {},
  ensureUnique = false,
): Promise<void> {
  try {
    if (!ctx.workspaceId) return;
    if (ensureUnique) {
      const existing = await supabase
        .from("product_events")
        .select("id")
        .eq("workspace_id", ctx.workspaceId)
        .eq("event_name", eventName)
        .limit(1)
        .maybeSingle();
      if (existing.data) return;
    }

    await supabase.from("product_events").insert({
      workspace_id: ctx.workspaceId,
      event_name: eventName,
      request_id: ctx.requestId ?? null,
      route: ctx.route ?? null,
      method: ctx.method ?? null,
      status: ctx.status ?? null,
      effective_plan: ctx.effectivePlan ?? null,
      plan_status: ctx.planStatus ?? null,
      props: props ?? {},
    });
  } catch (err) {
    logger.error({
      event: "product_event_emit_failed",
      event_target: eventName,
      message: redact((err as Error)?.message, "message"),
      err,
    });
  }
}

const reconcilePayUWebhook = createPayUWebhookReconciler({ emitProductEvent });

function effectivePlan(plan: AuthContext["plan"], status?: AuthContext["planStatus"]): AuthContext["plan"] {
  if (status === "active" || status === "trialing") return plan;
  return "pro";
}

async function sha256HexString(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function shortHash(value: string, length = 12): Promise<string> {
  const full = await sha256HexString(value);
  return full.slice(0, length);
}

function capExceededResponse(
  auth: AuthContext,
  caps: UsageSnapshot,
  usage: UsageSnapshot,
  rateHeaders: Record<string, string> | undefined,
  env: Env,
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
  effectivePlanOverride: EffectivePlanCode = "launch",
  planStatusOverride: AuthContext["planStatus"] = auth.planStatus ?? "past_due",
  logCtx?: { requestId?: string; route?: string; method?: string },
): Response {
  emitEventLog("cap_exceeded", {
    route: logCtx?.route ?? "",
    method: logCtx?.method ?? "",
    status: 402,
    request_id: logCtx?.requestId ?? "",
    workspace_id_redacted: redact(auth.workspaceId, "workspace_id"),
    effective_plan: effectivePlanOverride,
    plan_status: planStatusOverride,
  });
  return jsonResponse(
    {
      error: {
        code: "CAP_EXCEEDED",
        message: "Daily usage limits exceeded",
        upgrade_required: true,
        effective_plan: effectivePlanOverride,
        limits: caps,
        usage,
        upgrade_url: buildUpgradeUrl(env),
      },
    },
    402,
    rateHeaders,
  );
}

async function checkCapsAndMaybeRespond(
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
  auth: AuthContext,
  supabase: SupabaseClient,
  deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
  rateHeaders: Record<string, string> | undefined,
  env: Env,
  logCtx?: { requestId?: string; route?: string; method?: string },
): Promise<Response | null> {
  const quota = await resolveQuotaForWorkspace(auth, supabase);
  if (quota.blocked) {
    return jsonResponse(
      {
        error: {
          code: quota.errorCode,
          message: quota.message,
          upgrade_required: true,
          effective_plan: "launch",
          upgrade_url: buildUpgradeUrl(env),
          expired_at: quota.expiredAt,
        },
      },
      402,
      rateHeaders,
    );
  }
  const today = todayUtc();
  const usage = await getUsage(supabase, auth.workspaceId, today);
  const caps = quota.caps;
  const tooMuch = exceedsCaps(caps, usage as UsageSnapshot, deltas);
  if (tooMuch) {
    void emitProductEvent(
      supabase,
      "cap_exceeded",
      {
        workspaceId: auth.workspaceId,
        requestId: logCtx?.requestId,
        route: logCtx?.route,
        method: logCtx?.method,
        status: 402,
        effectivePlan: quota.effectivePlan,
        planStatus: quota.planStatus,
      },
      {},
    );
    return capExceededResponse(
      auth,
      caps,
      usage as UsageSnapshot,
      rateHeaders,
      env,
      jsonResponse,
      quota.effectivePlan,
      quota.planStatus,
      logCtx,
    );
  }
  return null;
}

function attachRequestIdToErrorPayload(data: unknown, status: number, requestId: string): unknown {
  if (status < 400) return data;
  if (!requestId) return data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const payload = data as Record<string, unknown>;
  if (!("error" in payload)) return data;
  if (typeof payload.request_id === "string" && payload.request_id.length > 0) return data;
  return { ...payload, request_id: requestId };
}

function createResponseFns(ctx: RequestContext): {
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response;
  emptyResponse: (status?: number) => Response;
} {
  const baseHeaders = buildResponseHeaders(ctx);
  return {
    jsonResponse: (data: unknown, status = 200, extraHeaders?: Record<string, string>) => {
      const body = attachRequestIdToErrorPayload(data, status, ctx.requestId);
      return new Response(JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...baseHeaders,
          ...(extraHeaders ?? {}),
        },
      });
    },
    emptyResponse: (status = 204) => new Response(null, { status, headers: baseHeaders }),
  };
}

/** Default deps when handlers are called directly (e.g. from tests) without going through route(). */
const simpleJsonResponse = (data: unknown, status = 200, extraHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(extraHeaders ?? {}) },
  });

type ErrorLogFields = {
  error_code?: string;
  error_message?: string;
};

async function extractErrorLogFields(response: Response | null): Promise<ErrorLogFields> {
  if (!response || response.status < 400) return {};
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return {};
  try {
    const payload = (await response.clone().json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    const code = typeof payload?.error?.code === "string" ? payload.error.code : undefined;
    const message = typeof payload?.error?.message === "string" ? payload.error.message : undefined;
    return {
      ...(code ? { error_code: code } : {}),
      ...(message ? { error_message: redact(message, "message") as string } : {}),
    };
  } catch {
    return {};
  }
}

function ensureRateLimitDo(env: Env): void {
  const ns = env.RATE_LIMIT_DO as unknown as { idFromName?: unknown; get?: unknown };
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    throw createHttpError(
      500,
      "CONFIG_ERROR",
      "Missing Durable Object binding RATE_LIMIT_DO. Check wrangler.toml durable_objects binding name.",
    );
  }
}

function isProductionStage(env: Env): boolean {
  const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "").trim().toLowerCase();
  return stage === "prod" || stage === "production" || stage === "staging";
}

function enforceRuntimeConfigGuards(env: Env): void {
  if (!isProductionStage(env)) return;
  const supabaseMode = (env.SUPABASE_MODE ?? "").trim().toLowerCase();
  if (supabaseMode === "stub") {
    throw createHttpError(500, "CONFIG_ERROR", "SUPABASE_MODE=stub is forbidden in production");
  }
  const embeddingsMode = (env.EMBEDDINGS_MODE ?? "openai").trim().toLowerCase();
  if (embeddingsMode === "stub") {
    throw createHttpError(500, "CONFIG_ERROR", "EMBEDDINGS_MODE=stub is forbidden in production");
  }
  const rateLimitMode = (env.RATE_LIMIT_MODE ?? "on").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(rateLimitMode)) {
    throw createHttpError(500, "CONFIG_ERROR", "RATE_LIMIT_MODE=off is forbidden in production");
  }
}

function resolveBodyLimit(method: string, path: string, env: Env): number {
  const base = Number(env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES);
  if (method === "POST" && path === "/v1/memories") return Math.min(base, MEMORIES_MAX_BODY_BYTES);
  if (method === "POST" && (path === "/v1/mcp" || path === "/mcp")) return Math.min(base, 262_144);
  if (
    method === "POST" &&
    (path === "/v1/search" ||
      path === "/v1/context" ||
      path === "/v1/context/feedback" ||
      path === "/v1/explain/answer" ||
      path === "/v1/search/replay" ||
      path === "/v1/evals/sets" ||
      path === "/v1/evals/items" ||
      path === "/v1/evals/run")
  )
    return Math.min(base, SEARCH_MAX_BODY_BYTES);
  if (path === "/v1/connectors/settings" && (method === "GET" || method === "PATCH")) {
    return Math.min(base, SEARCH_MAX_BODY_BYTES);
  }
  if (method === "POST" && path === "/v1/import") return Number(env.MAX_IMPORT_BYTES ?? DEFAULT_MAX_IMPORT_BYTES);
  if (method === "POST" && (path === "/v1/workspaces" || path === "/v1/api-keys" || path === "/v1/api-keys/revoke"))
    return Math.min(base, ADMIN_MAX_BODY_BYTES);
  return base;
}

/** Known paths and allowed methods (Phase 2: 405 for wrong method). Single source of truth per IMPROVEMENT_PLAN.md. */
const KNOWN_PATH_ALLOWED_METHODS: Array<{ test: (path: string) => boolean; allow: string }> = [
  { test: (p) => p === "/healthz", allow: "GET" },
  { test: (p) => p === "/ready" || p === "/ready/", allow: "GET" },
  { test: (p) => p === "/v1/health", allow: "GET" },
  { test: (p) => p === "/v1/mcp" || p === "/mcp", allow: "GET, POST, DELETE" },
  { test: (p) => p === "/v1/memories", allow: "GET, POST" },
  { test: (p) => /^\/v1\/memories\/[^/]+$/.test(p), allow: "GET, DELETE" },
  { test: (p) => p === "/v1/search/history", allow: "GET" },
  { test: (p) => p === "/v1/search/replay", allow: "POST" },
  { test: (p) => p === "/v1/search", allow: "POST" },
  { test: (p) => p === "/v1/evals/sets", allow: "GET, POST" },
  { test: (p) => /^\/v1\/evals\/sets\/[^/]+$/.test(p), allow: "DELETE" },
  { test: (p) => p === "/v1/evals/items", allow: "GET, POST" },
  { test: (p) => /^\/v1\/evals\/items\/[^/]+$/.test(p), allow: "DELETE" },
  { test: (p) => p === "/v1/evals/run", allow: "POST" },
  { test: (p) => p === "/v1/context", allow: "POST" },
  { test: (p) => p === "/v1/context/explain", allow: "GET" },
  { test: (p) => p === "/v1/context/feedback", allow: "POST" },
  { test: (p) => p === "/v1/pruning/metrics", allow: "GET" },
  { test: (p) => p === "/v1/explain/answer", allow: "POST" },
  { test: (p) => p === "/v1/usage/today", allow: "GET" },
  { test: (p) => p === "/v1/audit/log", allow: "GET" },
  { test: (p) => p === "/v1/dashboard/overview-stats", allow: "GET" },
  { test: (p) => p === "/v1/billing/status", allow: "GET" },
  { test: (p) => p === "/v1/billing/checkout", allow: "POST" },
  { test: (p) => p === "/v1/billing/portal", allow: "POST" },
  { test: (p) => p === "/v1/billing/webhook", allow: "POST" },
  { test: (p) => p === "/v1/workspaces", allow: "POST" },
  { test: (p) => p === "/v1/api-keys", allow: "GET, POST" },
  { test: (p) => p === "/v1/api-keys/revoke", allow: "POST" },
  { test: (p) => p === "/v1/import", allow: "POST" },
  { test: (p) => p === "/v1/connectors/settings", allow: "GET, PATCH" },
  { test: (p) => p === "/v1/admin/billing/health", allow: "GET" },
  { test: (p) => p === "/admin/webhooks/reprocess", allow: "POST" },
  { test: (p) => p === "/admin/usage/reconcile", allow: "POST" },
  { test: (p) => p === "/admin/sessions/cleanup", allow: "POST" },
  { test: (p) => p === "/admin/memory-hygiene", allow: "POST" },
  { test: (p) => p === "/admin/memory-retention", allow: "POST" },
  { test: (p) => p === "/v1/dashboard/session", allow: "POST" },
  { test: (p) => p === "/v1/dashboard/logout", allow: "POST" },
];

/** If path is known but method is not allowed, returns Allow header value; otherwise null (use 404). */
function getMethodNotAllowedForKnownPath(pathname: string, method: string): string | null {
  const upper = method.toUpperCase();
  for (const { test, allow } of KNOWN_PATH_ALLOWED_METHODS) {
    if (!test(pathname)) continue;
    const allowed = allow.split(",").map((m) => m.trim());
    if (allowed.includes(upper)) return null;
    return allow;
  }
  return null;
}

export function handleRequest(request: Request, env: Env): Promise<Response> {
  return runInRequestScope(() => handleRequestImpl(request, env));
}

async function handleRequestImpl(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, "") || "/";
    const requestId = resolveRequestId(request);
    const allowlist = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const origin = request.headers.get("origin") ?? "";
    const ctx: RequestContext = {
      requestId,
      securityHeaders: buildSecurityHeaders(pathname),
      corsHeaders: makeCorsHeaders(origin, allowlist, request.headers),
    };
    const { jsonResponse, emptyResponse } = createResponseFns(ctx);

    function logHealthReadyCompleted(status: number): void {
      const durationMs = Date.now() - started;
      logger.info({
        event: "request_completed",
        request_id: requestId,
        workspace_id: null,
        route: pathname,
        route_group: "health",
        method: request.method,
        status,
        status_code: status,
        latency_ms: durationMs,
        duration_ms: durationMs,
      });
    }

    // GET /healthz: return version, build_version, stage, embedding_model; 500 if critical env missing in non-dev
    if (pathname === "/healthz") {
      if (request.method !== "GET") {
        logHealthReadyCompleted(405);
        return new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }), {
          status: 405,
          headers: { "content-type": "application/json", Allow: "GET", ...buildResponseHeaders(ctx) },
        });
      }
      const stage = getEnvironmentStage(env);
      if (stage !== "dev") {
        const missing: string[] = [];
        if (!env.API_KEY_SALT) missing.push("API_KEY_SALT");
        if (missing.length > 0) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({
              status: "error",
              error: { code: "CONFIG_ERROR", message: `Missing critical env: ${missing.join(", ")}` },
            }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
        const stubError = validateStubModes(env, stage);
        if (stubError) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({ status: "error", error: { code: "CONFIG_ERROR", message: stubError } }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
        const rateLimitError = validateRateLimitConfig(env, stage);
        if (rateLimitError) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({ status: "error", error: { code: "CONFIG_ERROR", message: rateLimitError } }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
        const secretsError = validateSecrets(env, stage);
        if (secretsError) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({ status: "error", error: { code: "CONFIG_ERROR", message: secretsError } }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
      }
      const buildVersion = (env.BUILD_VERSION ?? "").trim();
      const version = buildVersion || "dev";
      const stageStr = (env.ENVIRONMENT ?? env.NODE_ENV ?? "").trim();
      const embeddingModel = effectiveEmbeddingModelLabelForHealth(env);
      logHealthReadyCompleted(200);
      return new Response(
        JSON.stringify({
          status: "ok",
          version,
          build_version: version,
          ...(stageStr ? { stage: stageStr } : {}),
          ...((env.GIT_SHA ?? "").trim() ? { git_sha: (env.GIT_SHA ?? "").trim() } : {}),
          embedding_model: embeddingModel,
        }),
        { status: 200, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
      );
    }

    // GET /ready: check Supabase connectivity; 503 if unavailable
    if (pathname === "/ready") {
      if (request.method !== "GET") {
        logHealthReadyCompleted(405);
        return new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }), {
          status: 405,
          headers: { "content-type": "application/json", Allow: "GET", ...buildResponseHeaders(ctx) },
        });
      }
      let supabaseForReady: SupabaseClient;
      try {
        supabaseForReady = createSupabaseClient(env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logHealthReadyCompleted(503);
        return new Response(
          JSON.stringify({ status: "degraded", db: "unavailable", message: msg }),
          { status: 503, headers: { "content-type": "application/json", "Cache-Control": "no-store", ...buildResponseHeaders(ctx) } },
        );
      }
      try {
        await withCircuitBreaker("supabase", async () => {
          const r = await withSupabaseQueryRetry(
            async () => {
              const result = await supabaseForReady.rpc("get_api_key_salt");
              return { data: result.data, error: result.error };
            },
            { delaysMs: SUPABASE_RETRY_DELAYS_MS },
          );
          if (r.error) throw r.error;
          return r;
        }, env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("CIRCUIT_OPEN:")) {
          logHealthReadyCompleted(503);
          return new Response(
            JSON.stringify({ status: "degraded", db: "unavailable", message: "Service temporarily unavailable" }),
            { status: 503, headers: { "content-type": "application/json", "Cache-Control": "no-store", ...buildResponseHeaders(ctx) } },
          );
        }
        const errMsg = e instanceof Error ? e.message : String(e);
        logHealthReadyCompleted(503);
        return new Response(
          JSON.stringify({ status: "degraded", db: "unavailable", message: errMsg }),
          { status: 503, headers: { "content-type": "application/json", "Cache-Control": "no-store", ...buildResponseHeaders(ctx) } },
        );
      }
      logHealthReadyCompleted(200);
      return new Response(JSON.stringify({ status: "ok", db: "connected" }), {
        status: 200,
        headers: { "content-type": "application/json", "Cache-Control": "no-store", ...buildResponseHeaders(ctx) },
      });
    }

    // GET /v1/health: versioned health (same payload as /healthz, no auth)
    if (pathname === "/v1/health" && request.method === "GET") {
      const stage = getEnvironmentStage(env);
      if (stage !== "dev") {
        const missing: string[] = [];
        if (!env.API_KEY_SALT) missing.push("API_KEY_SALT");
        if (missing.length > 0) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({
              status: "error",
              error: { code: "CONFIG_ERROR", message: `Missing critical env: ${missing.join(", ")}` },
            }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
        const secretsError = validateSecrets(env, stage);
        if (secretsError) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({ status: "error", error: { code: "CONFIG_ERROR", message: secretsError } }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
      }
      const buildVersion = (env.BUILD_VERSION ?? "").trim();
      const version = buildVersion || "dev";
      const stageStr = (env.ENVIRONMENT ?? env.NODE_ENV ?? "").trim();
      const embeddingModel = effectiveEmbeddingModelLabelForHealth(env);
      logHealthReadyCompleted(200);
      return new Response(
        JSON.stringify({
          status: "ok",
          version,
          build_version: version,
          ...(stageStr ? { stage: stageStr } : {}),
          ...((env.GIT_SHA ?? "").trim() ? { git_sha: (env.GIT_SHA ?? "").trim() } : {}),
          embedding_model: embeddingModel,
        }),
        { status: 200, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
      );
    }

    const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown";
    const originAllowed = isOriginAllowed(origin, allowlist);
    let supabase: SupabaseClient | null = null;
    const auditCtx: { workspaceId?: string; apiKeyId?: string } = {};
    let response: Response | null = null;
    try {
      if (allowlist && !originAllowed && !isHostedMcpPath(pathname)) {
        response = jsonResponse({ error: { code: "CORS_DENY", message: "Origin not allowed" } }, 403);
        return response;
      }

      enforceRuntimeConfigGuards(env);
      ensureRateLimitDo(env);

      if (request.method === "OPTIONS") {
        response = emptyResponse();
        return response;
      }

      const bodyLimit = resolveBodyLimit(request.method, url.pathname, env);
      await assertBodySize(request, env, bodyLimit);

      // 405 for known path + wrong method (before creating Supabase so no CONFIG_ERROR for wrong-method-only requests)
      const earlyAllow = getMethodNotAllowedForKnownPath(url.pathname, request.method);
      if (earlyAllow !== null) {
        response = jsonResponse(
          { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed for this resource" } },
          405,
          { Allow: earlyAllow },
        );
        return response;
      }

      // Production/staging: dashboard routes require ALLOWED_ORIGINS before creating Supabase
      if (url.pathname.startsWith("/v1/dashboard") && isProductionStage(env)) {
        const dashboardAllowlist = parseAllowedOrigins(env.ALLOWED_ORIGINS);
        if (!dashboardAllowlist || dashboardAllowlist.length === 0) {
          response = jsonResponse(
            {
              error: {
                code: "CONFIG_ERROR",
                message: "ALLOWED_ORIGINS must be set in production for dashboard access",
              },
            },
            503,
          );
          return response;
        }
      }

      supabase = createSupabaseClient(env);
      logger.info({
        event: "db_access_path_selected",
        request_id: requestId,
        route: url.pathname,
        path_mode: isRlsFirstAccessMode(env) || isServiceRoleRequestPathDisabled(env) ? "scoped_rls" : "service_direct",
      });

      if (isHostedMcpPath(pathname)) {
        const mcpIpRate = await rateLimit(`mcp-ip:${ip}`, env, undefined, getRateLimitMax(env));
        if (!mcpIpRate.allowed) {
          response = jsonResponse(
            { error: { code: "rate_limited", message: "Rate limit exceeded" } },
            429,
            mcpIpRate.headers,
          );
          return response;
        }
        response = await handleHostedMcpRequest(request, env, supabase, ctx, requestId, auditCtx);
        return response;
      }

      // Dashboard session (Phase 0.2): create session from Supabase token, or logout
      if (request.method === "POST" && url.pathname === "/v1/dashboard/session") {
        const dashRate = await rateLimit(
          `dashboard-session:${ip}`,
          env,
          undefined,
          getRouteRateLimitMax(env, "dashboard_session"),
        );
        if (!dashRate.allowed) {
          response = jsonResponse(
            { error: { code: "rate_limited", message: "Rate limit exceeded" } },
            429,
            dashRate.headers,
          );
          return response;
        }
        let body: { access_token?: string; workspace_id?: string };
        try {
          body = (await request.json()) as { access_token?: string; workspace_id?: string };
        } catch {
          response = jsonResponse({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, 400);
          return response;
        }
        const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
        const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
        if (!accessToken || !workspaceId) {
          response = jsonResponse(
            { error: { code: "BAD_REQUEST", message: "access_token and workspace_id are required" } },
            400,
          );
          return response;
        }
        const verified = await verifySupabaseAccessToken(accessToken, env);
        if (!verified) {
          response = jsonResponse({ error: { code: "UNAUTHORIZED", message: "Invalid or expired Supabase token" } }, 401);
          return response;
        }
        const dashboardScoped = isRlsFirstAccessMode(env) || isServiceRoleRequestPathDisabled(env)
          ? await createRequestScopedSupabaseClient(env, {
            workspaceId,
            keyHash: `dashboard:${verified.userId}`,
            apiKeyId: verified.userId,
            plan: "pro",
            planStatus: "past_due",
          })
          : supabase;
        const { data: member } = await dashboardScoped
          .from("workspace_members")
          .select("workspace_id")
          .eq("workspace_id", workspaceId)
          .eq("user_id", verified.userId)
          .maybeSingle();
        if (!member) {
          response = jsonResponse(
            { error: { code: "PERMISSION_DENIED", message: "Not a member of this workspace" } },
            403,
          );
          return response;
        }
        const { sessionId, csrfToken } = await createDashboardSession(dashboardScoped, verified.userId, workspaceId, SESSION_TTL_SEC);
        const isSecure = url.protocol === "https:";
        const cookieHeader = sessionCookieHeader(sessionId, SESSION_TTL_SEC, isSecure);
        response = new Response(JSON.stringify({ ok: true, csrf_token: csrfToken }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "Set-Cookie": cookieHeader,
            ...buildResponseHeaders(ctx),
          },
        });
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/dashboard/logout") {
        const dashRate = await rateLimit(
          `dashboard-session:${ip}`,
          env,
          undefined,
          getRouteRateLimitMax(env, "dashboard_session"),
        );
        if (!dashRate.allowed) {
          response = jsonResponse(
            { error: { code: "rate_limited", message: "Rate limit exceeded" } },
            429,
            dashRate.headers,
          );
          return response;
        }
        const dashSession = await getDashboardSession(request, supabase);
        if (dashSession) {
          try {
            validateDashboardCsrf(request, dashSession, parseAllowedOrigins(env.ALLOWED_ORIGINS));
          } catch {
            response = jsonResponse(
              { error: { code: "PERMISSION_DENIED", message: "Invalid or missing CSRF token" } },
              403,
            );
            return response;
          }
          await deleteDashboardSession(supabase, dashSession.sessionId);
        }
        const isSecure = url.protocol === "https:";
        response = new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "Set-Cookie": clearSessionCookieHeader(isSecure),
            ...buildResponseHeaders(ctx),
          },
        });
        return response;
      }

      if (
        isServiceRoleRequestPathDisabled(env) &&
        (url.pathname.startsWith("/admin/") ||
          url.pathname === "/v1/billing/webhook" ||
          url.pathname.startsWith("/v1/admin/"))
      ) {
        response = jsonResponse(
          {
            error: {
              code: "CONTROL_PLANE_ONLY",
              message: "This endpoint is disabled on request path in rls-first mode",
            },
          },
          503,
        );
        return response;
      }

      const handlerDeps: HandlerDeps &
        MemoryHandlerDeps &
        SearchHandlerDeps &
        UsageHandlerDeps &
        AuditLogHandlerDeps &
        BillingHandlerDeps &
        WebhookHandlerDeps &
        AdminHandlerDeps &
        ImportHandlerDeps &
        WorkspacesHandlerDeps &
        ApiKeysHandlerDeps = {
        jsonResponse,
        safeParseJson,
        chunkText: chunkTextWithProfile,
        embedText,
        todayUtc,
        vectorToPgvectorString,
        emitProductEvent,
        bumpUsage,
        effectivePlan,
        normalizeMemoryListParams,
        performListMemories,
        getMemoryByIdScoped,
        deleteMemoryCascade,
        checkCapsAndMaybeRespond,
        performSearch,
        getUsage,
        resolveQuotaForWorkspace,
        reserveQuotaAndMaybeRespond,
        markUsageReservationCommitted,
        markUsageReservationRefundPending,
        planLimitExceededResponse,
        estimateEmbedTokens,
        normalizePlanStatus,
        emitEventLog,
        redact,
        isPayUBillingConfigured,
        assertPayUEnvFor,
        shortHash,
        fetchPayUTransactionByTxnId,
        formatAmountStrict,
        normalizeCurrency,
        transitionPayUTransactionStatus: transitionPayUTransactionStatus as BillingHandlerDeps["transitionPayUTransactionStatus"],
        buildPayURequestHashInput,
        computeSha512Hex,
        normalizePayUBaseUrl,
        resolveEntitlementPlanCode,
        getAmountForPlan: resolvePayUAmountForPlan,
        getProductInfoForPlan: resolveProductInfoForPlan,
        defaultSuccessPath: DEFAULT_SUCCESS_PATH,
        defaultCancelPath: DEFAULT_CANCEL_PATH,
        defaultProductInfo: DEFAULT_PAYU_PRODUCT_INFO,
        resolveBillingWebhooksEnabled,
        parseWebhookPayload: parseWebhookPayload as WebhookHandlerDeps["parseWebhookPayload"],
        asNonEmptyString,
        isPayUWebhookSignatureValid: isPayUWebhookSignatureValid as WebhookHandlerDeps["isPayUWebhookSignatureValid"],
        resolvePayUEventId: resolvePayUEventId as WebhookHandlerDeps["resolvePayUEventId"],
        resolvePayUEventType: resolvePayUEventType as WebhookHandlerDeps["resolvePayUEventType"],
        resolvePayUEventCreated: resolvePayUEventCreated as WebhookHandlerDeps["resolvePayUEventCreated"],
        reconcilePayUWebhook: reconcilePayUWebhook as WebhookHandlerDeps["reconcilePayUWebhook"],
        logger: logger as unknown as WebhookHandlerDeps["logger"],
        isApiError,
        requireAdmin,
        rateLimit,
        rateLimitWorkspace,
        defaultWebhookReprocessLimit: DEFAULT_WEBHOOK_REPROCESS_LIMIT,
        resolvePayUVerifyTimeoutMs,
        importArtifact: importArtifact as ImportHandlerDeps["importArtifact"],
        defaultMaxImportBytes: DEFAULT_MAX_IMPORT_BYTES,
        generateApiKey,
        getApiKeySalt,
        hashApiKey,
        getFounderPhase1Metrics,
        setStubApiKeyIfPresent,
      };
      const memoryHandlers = createMemoryHandlers(handlerDeps, defaultMemoryHandlerDeps);
      const searchHandlers = createSearchHandlers(handlerDeps, defaultSearchHandlerDeps);
      const contextHandlers = createContextHandlers(handlerDeps, defaultSearchHandlerDeps);
      const contextExplainHandlers = createContextExplainHandlers(handlerDeps, defaultSearchHandlerDeps);
      const usageHandlers = createUsageHandlers(handlerDeps, defaultUsageHandlerDeps);
      const auditLogHandlers = createAuditLogHandlers(handlerDeps, defaultAuditLogHandlerDeps);
      const dashboardOverviewHandlers = createDashboardOverviewHandlers(handlerDeps, defaultDashboardOverviewDeps);
      const billingHandlers = createBillingHandlers(handlerDeps, defaultBillingHandlerDeps);
      const webhookHandlers = createWebhookHandlers(handlerDeps, defaultWebhookHandlerDeps);
      const adminHandlers = createAdminHandlers(handlerDeps, defaultAdminHandlerDeps);
      const importHandlers = createImportHandlers(handlerDeps, defaultImportHandlerDeps);
      const connectorSettingsHandlers = createConnectorSettingsHandlers(handlerDeps, { jsonResponse });
      const workspacesHandlers = createWorkspacesHandlers(handlerDeps, defaultWorkspacesHandlerDeps);
      const apiKeysHandlers = createApiKeysHandlers(handlerDeps, defaultApiKeysHandlerDeps);
      const evalHandlers = createEvalHandlers(handlerDeps, defaultEvalHandlerDeps);
      const pruningHandlers = createPruningHandlers(
        {
          jsonResponse,
          resolveQuotaForWorkspace,
          rateLimitWorkspace,
        },
        {
          jsonResponse,
          resolveQuotaForWorkspace,
          rateLimitWorkspace,
        },
      );
      const explainHandlers = createExplainHandlers(handlerDeps, defaultSearchHandlerDeps);
      const routed = await route(request, env, supabase, url, auditCtx, requestId, {
        handlers: {
          ...memoryHandlers,
          ...searchHandlers,
          ...contextHandlers,
          ...contextExplainHandlers,
          ...usageHandlers,
          ...auditLogHandlers,
          ...dashboardOverviewHandlers,
          ...billingHandlers,
          ...webhookHandlers,
          ...adminHandlers,
          ...importHandlers,
          ...connectorSettingsHandlers,
          ...workspacesHandlers,
          ...apiKeysHandlers,
          ...evalHandlers,
          ...pruningHandlers,
          ...explainHandlers,
        },
        handlerDeps,
      });
      if (routed !== null) {
        response = routed;
        return response;
      }
      response = jsonResponse({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      return response;
    } catch (error: unknown) {
      const status = isApiError(error) ? error.status ?? 500 : 500;
      const errorCode = isApiError(error) ? error.code : "INTERNAL";
      const safeMessage = redact((error as Error)?.message, "message");
      logger.error({
        event: "request_failed",
        request_id: requestId,
        route: url.pathname,
        method: request.method,
        status,
        error_code: errorCode,
        error_message: safeMessage,
        workspace_id: auditCtx.workspaceId ?? null,
        err: error,
      });
      if (isApiError(error)) {
        response = jsonResponse(
          { error: { code: error.code, message: error.message } },
          error.status ?? 500,
          error.headers,
        );
        return response;
      }
      response = jsonResponse(
        { error: { code: "INTERNAL", message: "Unexpected error occurred" } },
        500,
      );
      return response;
    } finally {
        try {
          await emitAuditLog(request, response, started, ip, env, supabase, auditCtx, requestId);
          const durationMs = Date.now() - started;
          const routeGroup = classifyRouteGroup(url.pathname);
          const errorFields = await extractErrorLogFields(response);
          logger.info({
            event: "request_completed",
            request_id: requestId,
            workspace_id: auditCtx.workspaceId ?? null,
            route: url.pathname,
            route_group: routeGroup,
            method: request.method,
            status: response?.status ?? 0,
            status_code: response?.status ?? 0,
            latency_ms: durationMs,
            duration_ms: durationMs,
            ...(errorFields.error_code ? { error_type: errorFields.error_code } : {}),
            ...errorFields,
          });
          if (supabase) {
            await persistApiRequestEvent(supabase, {
              requestId,
              workspaceId: auditCtx.workspaceId,
              route: url.pathname,
              routeGroup,
              method: request.method,
              status: response?.status ?? 0,
              latencyMs: durationMs,
            });
          }
        } catch (_) {
          /* Logging best-effort; avoid masking original error */
        }
      }
}

export { createSupabaseClient };

/** Classify a URL pathname into a route group for golden-metrics aggregation. */
function classifyRouteGroup(pathname: string): string {
  if (pathname === "/healthz" || pathname === "/ready" || pathname === "/ready/") return "health";
  if (pathname === "/v1/health") return "health";
  if (pathname === "/v1/memories" || /^\/v1\/memories\/[^/]+$/.test(pathname)) return "memories";
  if (pathname === "/v1/search" || pathname === "/v1/search/history" || pathname === "/v1/search/replay")
    return "search";
  if (pathname.startsWith("/v1/evals/")) return "evals";
  if (pathname === "/v1/context" || pathname === "/v1/context/explain" || pathname === "/v1/context/feedback")
    return "context";
  if (pathname === "/v1/pruning/metrics") return "pruning";
  if (pathname === "/v1/explain/answer") return "explain";
  if (pathname === "/v1/usage/today" || pathname === "/v1/audit/log") return "usage";
  if (pathname.startsWith("/v1/dashboard/")) return "dashboard";
  if (pathname.startsWith("/v1/billing/")) return "billing";
  if (pathname === "/v1/workspaces") return "workspaces";
  if (pathname.startsWith("/v1/api-keys")) return "api_keys";
  if (pathname === "/v1/import") return "import";
  if (pathname === "/v1/connectors/settings") return "connectors";
  if (pathname === "/v1/mcp" || pathname === "/mcp") return "mcp";
  if (pathname.startsWith("/v1/admin/") || pathname.startsWith("/admin/")) return "admin";
  return "unknown";
}

function rangeDurationMs(range: FounderMetricsRange): number {
  return range === "24h" ? 24 * 60 * 60 * 1000 : range === "7d" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
}

function toFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeIsoTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * 0.95;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

async function persistApiRequestEvent(
  supabase: SupabaseClient,
  event: {
    requestId: string;
    workspaceId?: string;
    route: string;
    routeGroup: string;
    method: string;
    status: number;
    latencyMs: number;
  },
): Promise<void> {
  try {
    await supabase.from("api_request_events").insert({
      request_id: event.requestId,
      workspace_id: event.workspaceId ?? null,
      route: event.route,
      route_group: event.routeGroup,
      method: event.method,
      status: event.status,
      latency_ms: Math.max(0, Math.round(event.latencyMs)),
    });
  } catch (err) {
    const message = (err as Error)?.message ?? "";
    if (message.includes("Unexpected table: api_request_events")) return;
    logger.error({
      event: "api_request_event_persist_failed",
      route: event.route,
      request_id: event.requestId,
      message: redact(message, "message"),
    });
  }
}

async function getFounderPhase1Metrics(
  supabase: SupabaseClient,
  range: FounderMetricsRange,
): Promise<Record<string, unknown>> {
  const nowMs = Date.now();
  const spanMs = rangeDurationMs(range);
  const currentStartMs = nowMs - spanMs;
  const previousStartMs = currentStartMs - spanMs;
  const previousPreviousStartMs = previousStartMs - spanMs;
  const activationWindowMs = 7 * 24 * 60 * 60 * 1000;
  const publicRouteGroups = ["memories", "search", "context", "usage", "import", "billing", "dashboard", "api_keys"];
  const activationEventNames = ["api_key_created", "first_ingest_success", "first_search_success", "first_context_success"];

  const currentStartIso = new Date(currentStartMs).toISOString();
  const previousStartIso = new Date(previousStartMs).toISOString();
  const previousPreviousStartIso = new Date(previousPreviousStartMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  const [requestEventsRes, searchEventsRes, workspacesRes, activationEventsRes] = await Promise.all([
    supabase
      .from("api_request_events")
      .select("workspace_id, created_at, route_group, status, latency_ms")
      .gte("created_at", previousPreviousStartIso)
      .lt("created_at", nowIso),
    supabase
      .from("product_events")
      .select("workspace_id, created_at, event_name, props")
      .eq("event_name", "search_executed")
      .gte("created_at", previousStartIso)
      .lt("created_at", nowIso),
    supabase
      .from("workspaces")
      .select("id, created_at")
      .gte("created_at", previousPreviousStartIso)
      .lt("created_at", nowIso),
    supabase
      .from("product_events")
      .select("workspace_id, created_at, event_name")
      .in("event_name", activationEventNames)
      .gte("created_at", previousPreviousStartIso)
      .lt("created_at", nowIso),
  ]);

  if (requestEventsRes.error) {
    throw createHttpError(500, "DB_ERROR", requestEventsRes.error.message ?? "Failed to load request telemetry");
  }
  if (searchEventsRes.error) {
    throw createHttpError(500, "DB_ERROR", searchEventsRes.error.message ?? "Failed to load search telemetry");
  }
  if (workspacesRes.error) {
    throw createHttpError(500, "DB_ERROR", workspacesRes.error.message ?? "Failed to load workspaces");
  }
  if (activationEventsRes.error) {
    throw createHttpError(500, "DB_ERROR", activationEventsRes.error.message ?? "Failed to load activation events");
  }

  const requestEvents = ((requestEventsRes.data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
    workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
    createdAtMs: safeIsoTime(row.created_at) ?? 0,
    routeGroup: typeof row.route_group === "string" ? row.route_group : "unknown",
    status: toFiniteNumber(row.status),
    latencyMs: toFiniteNumber(row.latency_ms),
  }));
  const searchEvents = ((searchEventsRes.data as Array<Record<string, unknown>> | null) ?? []).map((row) => {
    const props = (row.props ?? {}) as Record<string, unknown>;
    return {
      workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
      createdAtMs: safeIsoTime(row.created_at) ?? 0,
      zeroResults: props.zero_results === true,
      resultCount: toFiniteNumber(props.result_count),
    };
  });
  const workspaces = ((workspacesRes.data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
    id: typeof row.id === "string" ? row.id : "",
    createdAtMs: safeIsoTime(row.created_at) ?? 0,
  })).filter((row) => row.id);
  const activationEvents = ((activationEventsRes.data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
    workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : "",
    createdAtMs: safeIsoTime(row.created_at) ?? 0,
  })).filter((row) => row.workspaceId);

  const firstActivationAt = new Map<string, number>();
  for (const event of activationEvents) {
    const existing = firstActivationAt.get(event.workspaceId);
    if (existing == null || event.createdAtMs < existing) firstActivationAt.set(event.workspaceId, event.createdAtMs);
  }

  const computeActivationRate = (windowStartMs: number, windowEndMs: number) => {
    const cohort = workspaces.filter((row) => row.createdAtMs >= windowStartMs && row.createdAtMs < windowEndMs);
    const activated = cohort.filter((row) => {
      const activatedAt = firstActivationAt.get(row.id);
      return activatedAt != null && activatedAt >= row.createdAtMs && activatedAt <= row.createdAtMs + activationWindowMs;
    });
    return {
      numerator: activated.length,
      denominator: cohort.length,
      pct: cohort.length > 0 ? (activated.length / cohort.length) * 100 : 0,
    };
  };

  const hasActivityInWindow = (workspaceId: string, windowStartMs: number, windowEndMs: number) =>
    requestEvents.some((row) =>
      row.workspaceId === workspaceId &&
      row.createdAtMs >= windowStartMs &&
      row.createdAtMs < windowEndMs &&
      publicRouteGroups.includes(row.routeGroup),
    );

  const computeRetentionRate = (cohortStartMs: number, cohortEndMs: number, activityStartMs: number, activityEndMs: number) => {
    const cohort = workspaces.filter((row) => row.createdAtMs >= cohortStartMs && row.createdAtMs < cohortEndMs);
    const activated = cohort.filter((row) => {
      const activatedAt = firstActivationAt.get(row.id);
      return activatedAt != null && activatedAt >= row.createdAtMs && activatedAt <= row.createdAtMs + activationWindowMs;
    });
    const retained = activated.filter((row) => hasActivityInWindow(row.id, activityStartMs, activityEndMs));
    return {
      numerator: retained.length,
      denominator: activated.length,
      pct: activated.length > 0 ? (retained.length / activated.length) * 100 : 0,
    };
  };

  const summarizeWindow = (windowStartMs: number, windowEndMs: number, retentionCohortStartMs: number, retentionCohortEndMs: number) => {
    const reqs = requestEvents.filter((row) => row.createdAtMs >= windowStartMs && row.createdAtMs < windowEndMs);
    const nonAdminReqs = reqs.filter((row) => row.status > 0 && row.routeGroup !== "admin");
    const failures = nonAdminReqs.filter((row) => row.status >= 500);
    const searchReqs = reqs.filter((row) => row.routeGroup === "search" && row.status > 0 && row.status < 500);
    const searchWindowEvents = searchEvents.filter((row) => row.createdAtMs >= windowStartMs && row.createdAtMs < windowEndMs);
    const activeWorkspaces = new Set(
      reqs
        .filter((row) => row.workspaceId && publicRouteGroups.includes(row.routeGroup))
        .map((row) => row.workspaceId as string),
    );
    const activation = computeActivationRate(windowStartMs, windowEndMs);
    const retention = computeRetentionRate(retentionCohortStartMs, retentionCohortEndMs, windowStartMs, windowEndMs);
    const searchP95 = percentile95(searchReqs.map((row) => row.latencyMs));
    const zeroResultCount = searchWindowEvents.filter((row) => row.zeroResults || row.resultCount === 0).length;

    return {
      api_uptime_pct: nonAdminReqs.length > 0 ? ((nonAdminReqs.length - failures.length) / nonAdminReqs.length) * 100 : 100,
      http_5xx_rate_pct: nonAdminReqs.length > 0 ? (failures.length / nonAdminReqs.length) * 100 : 0,
      search_latency_p95_ms: searchP95 == null ? null : Math.round(searchP95),
      zero_result_rate_pct: searchWindowEvents.length > 0 ? (zeroResultCount / searchWindowEvents.length) * 100 : 0,
      active_workspaces: activeWorkspaces.size,
      activation_rate_pct: activation.pct,
      retention_7d_pct: retention.pct,
      counts: {
        requests: nonAdminReqs.length,
        failures_5xx: failures.length,
        searches: searchWindowEvents.length,
        zero_result_searches: zeroResultCount,
        new_workspaces: activation.denominator,
        activated_workspaces: activation.numerator,
        retention_cohort: retention.denominator,
        retained_workspaces: retention.numerator,
      },
    };
  };

  return {
    generated_at: new Date(nowMs).toISOString(),
    range,
    current: summarizeWindow(currentStartMs, nowMs, previousStartMs, currentStartMs),
    previous: summarizeWindow(previousStartMs, currentStartMs, previousPreviousStartMs, previousStartMs),
    windows: {
      current_start: currentStartIso,
      current_end: nowIso,
      previous_start: previousStartIso,
      previous_end: currentStartIso,
    },
  };
}

function createSupabaseClient(env: Env): SupabaseClient {
  const supabaseMode = (env.SUPABASE_MODE ?? "").toLowerCase();
  if (supabaseMode === "stub") {
    if (isProductionStage(env)) {
      throw createHttpError(500, "CONFIG_ERROR", "SUPABASE_MODE=stub is forbidden in production");
    }
    return createStubSupabase(env) as unknown as SupabaseClient;
  }
  if (isRlsFirstAccessMode(env) || isServiceRoleRequestPathDisabled(env)) {
    return createAnonSupabaseClient(env);
  }
  return createServiceRoleSupabaseClient(env);
}

type StubRow = Record<string, unknown>;
type StubFilter = { col: string; val: unknown; op: "eq" | "in" | "contains" | "gte" | "lte" | "lt" };

let stubState: {
  db: {
    workspaces: StubRow[];
    api_keys: StubRow[];
    memories: StubRow[];
    memory_chunks: StubRow[];
    usage_daily: StubRow[];
    usage_daily_v2: StubRow[];
    usage_events: StubRow[];
    plans: StubRow[];
    entitlements: StubRow[];
    invoice_lines: StubRow[];
    usage_alert_events: StubRow[];
    usage_reservations: StubRow[];
    api_audit_log: StubRow[];
    app_settings: StubRow[];
    product_events: StubRow[];
    api_request_events: StubRow[];
    payu_webhook_events: StubRow[];
    payu_transactions: StubRow[];
    dashboard_sessions: StubRow[];
    agent_episodes: StubRow[];
    eval_sets: StubRow[];
    eval_items: StubRow[];
  };
  rawApiKeys: Map<string, { workspaceId: string }>;
} | null = null;

function createStubSupabase(env: Env) {
  if (!stubState) {
    stubState = {
      db: {
        workspaces: [] as StubRow[],
        api_keys: [] as StubRow[],
        memories: [] as StubRow[],
        memory_chunks: [] as StubRow[],
        usage_daily: [] as StubRow[],
        usage_daily_v2: [] as StubRow[],
        usage_events: [] as StubRow[],
        plans: [] as StubRow[],
        entitlements: [] as StubRow[],
        invoice_lines: [] as StubRow[],
        usage_alert_events: [] as StubRow[],
        usage_reservations: [] as StubRow[],
        api_audit_log: [] as StubRow[],
        app_settings: [{ api_key_salt: env.API_KEY_SALT ?? "" }],
        product_events: [] as StubRow[],
        api_request_events: [] as StubRow[],
        payu_webhook_events: [] as StubRow[],
        payu_transactions: [] as StubRow[],
        dashboard_sessions: [] as StubRow[],
        agent_episodes: [] as StubRow[],
        eval_sets: [] as StubRow[],
        eval_items: [] as StubRow[],
      },
      rawApiKeys: new Map<string, { workspaceId: string }>(),
    };
  }
  const { db, rawApiKeys } = stubState;

  const applyFilters = (rows: StubRow[], filters: StubFilter[]) =>
    rows.filter((r) =>
      filters.every((f) => {
        if (f.op === "contains") {
          const target = r[f.col] as Record<string, unknown>;
          return (
            typeof target === "object" &&
            target !== null &&
            Object.entries(f.val as Record<string, unknown>).every(([k, v]) => target[k] === v)
          );
        }
        if (f.op === "in") {
          const values = Array.isArray(f.val) ? f.val : [];
          return values.includes(r[f.col]);
        }
        if (f.op === "gte") return (r[f.col] as string) >= (f.val as string);
        if (f.op === "lte") return (r[f.col] as string) <= (f.val as string);
        if (f.op === "lt") return (r[f.col] as string) < (f.val as string);
        return r[f.col] === f.val;
      }),
    );

  const makeResult = (rows: StubRow[], count?: number) => ({
    data: rows,
    error: null,
    count,
    limit() {
      return this;
    },
    eq(col: string, val: unknown) {
      return makeResult(
        rows.filter((r) => r[col] === val),
        count ? rows.filter((r) => r[col] === val).length : undefined,
      );
    },
    in(col: string, vals: unknown[]) {
      const filtered = rows.filter((r) => vals.includes(r[col]));
      return makeResult(filtered, count ? filtered.length : undefined);
    },
    is(col: string, val: unknown) {
      return this.eq(col, val);
    },
    gte(col: string, val: unknown) {
      return makeResult(
        rows.filter((r) => (r[col] as string) >= (val as string)),
        count ? rows.filter((r) => (r[col] as string) >= (val as string)).length : undefined,
      );
    },
    lt(col: string, val: unknown) {
      return makeResult(
        rows.filter((r) => (r[col] as string) < (val as string)),
        count ? rows.filter((r) => (r[col] as string) < (val as string)).length : undefined,
      );
    },
    lte(col: string, val: unknown) {
      return makeResult(
        rows.filter((r) => (r[col] as string) <= (val as string)),
        count ? rows.filter((r) => (r[col] as string) <= (val as string)).length : undefined,
      );
    },
    contains(obj: Record<string, unknown>) {
      const filtered = rows.filter((r) => {
        const target = r.metadata as Record<string, unknown>;
        return typeof target === "object" && target !== null && Object.entries(obj).every(([k, v]) => target[k] === v);
      });
      return makeResult(filtered, count ? filtered.length : undefined);
    },
    order(col: string, opts?: { ascending?: boolean }) {
      const asc = opts?.ascending !== false;
      let sorted = rows;
      if (col === "created_at" || col === "id") {
        sorted = [...rows].sort((a, b) => {
          if (col === "created_at") {
            const ca = String(a.created_at ?? "");
            const cb = String(b.created_at ?? "");
            const c = ca.localeCompare(cb);
            if (c !== 0) return asc ? c : -c;
          }
          const ia = String(a.id ?? "");
          const ib = String(b.id ?? "");
          const idc = ia.localeCompare(ib);
          return asc ? idc : -idc;
        });
      }
      return makeResult(sorted, count);
    },
    range(from?: number, to?: number) {
      if (typeof from === "number" && typeof to === "number" && Number.isFinite(from) && Number.isFinite(to) && to >= from && from >= 0) {
        return makeResult(rows.slice(from, to + 1), count);
      }
      return this;
    },
    maybeSingle() {
      return { data: rows[0] ?? null, error: null };
    },
    single() {
      return { data: rows[0] ?? null, error: null };
    },
    then<T>(onfulfilled?: (value: { data: StubRow[]; error: null }) => T | PromiseLike<T>, onrejected?: (reason: unknown) => never) {
      return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
    },
  });

  const tableBuilder = (table: keyof typeof db, filters: StubFilter[] = []) => ({
    eq(col: string, val: unknown) {
      filters.push({ col, val, op: "eq" });
      return tableBuilder(table, filters);
    },
    in(col: string, vals: unknown[]) {
      filters.push({ col, val: [...vals], op: "in" });
      return tableBuilder(table, filters);
    },
    contains(obj: Record<string, unknown>) {
      filters.push({ col: "metadata", val: obj, op: "contains" });
      return tableBuilder(table, filters);
    },
    gte(col: string, val: unknown) {
      filters.push({ col, val, op: "gte" });
      return tableBuilder(table, filters);
    },
    lte(col: string, val: unknown) {
      filters.push({ col, val, op: "lte" });
      return tableBuilder(table, filters);
    },
    select(_cols?: string, opts?: { count?: "exact" }) {
      const rows = applyFilters(db[table], filters);
      return makeResult(rows, opts?.count ? rows.length : undefined);
    },
    limit(_n: number) {
      void _n;
      return this;
    },
    insert(payload: StubRow | StubRow[]) {
      const rows = Array.isArray(payload) ? payload : [payload];
      rows.forEach((r) => {
        if (table === "api_keys" && !Object.prototype.hasOwnProperty.call(r, "revoked_at")) {
          (r as Record<string, unknown>).revoked_at = null;
        }
        if (!r.id) (r as Record<string, unknown>).id = crypto.randomUUID();
        if (!Object.prototype.hasOwnProperty.call(r, "created_at"))
          (r as Record<string, unknown>).created_at = new Date().toISOString();
        if (table === "eval_sets" && !Object.prototype.hasOwnProperty.call(r, "updated_at")) {
          (r as Record<string, unknown>).updated_at = (r as Record<string, unknown>).created_at;
        }
        if (table === "memories") {
          const rec = r as Record<string, unknown>;
          if (rec.importance === undefined) rec.importance = 1;
          if (rec.retrieval_count === undefined) rec.retrieval_count = 0;
        }
        db[table].push(structuredClone(r));
        if (table === "workspaces") {
          const nowIso = new Date().toISOString();
          db.entitlements.push({
            id: crypto.randomUUID(),
            workspace_id: String((r as Record<string, unknown>).id),
            source_txn_id: `stub_entitlement_${String((r as Record<string, unknown>).id)}`,
            plan_code: "launch",
            status: "active",
            starts_at: new Date(Date.now() - 60_000).toISOString(),
            expires_at: null,
            caps_json: capsByPlanCode("launch"),
            metadata: { source: "stub_workspace_bootstrap" },
            created_at: nowIso,
            updated_at: nowIso,
          });
        }
      });
      return {
        select(_sel?: string) {
          void _sel;
          return {
            single: async () => ({ data: rows[0], error: null }),
            maybeSingle: async () => ({ data: rows[0], error: null }),
          };
        },
        single: async () => ({ data: rows[0], error: null }),
        maybeSingle: async () => ({ data: rows[0], error: null }),
        error: null,
        data: rows,
      };
    },
    update(values: Record<string, unknown>) {
      return {
        eq(col: string, val: unknown) {
          const withEq = filters.concat({ col, val, op: "eq" });
          return {
            in(col2: string, vals: unknown[]) {
              const withIn = withEq.concat({ col: col2, val: vals, op: "in" });
              const rows = applyFilters(db[table], withIn);
              rows.forEach((r) => Object.assign(r, values));
              return { data: rows, error: null };
            },
            then<TResult1 = unknown, TResult2 = never>(
              onfulfilled?: ((value: { data: StubRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) {
              const rows = applyFilters(db[table], withEq);
              rows.forEach((r) => Object.assign(r, values));
              return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
            },
          };
        },
      };
    },
    delete(opts?: { count?: "exact" }) {
      const deleteFilters = [...filters];
      let executed = false;
      let result: { data: StubRow[]; error: null; count: number | null } = {
        data: [],
        error: null,
        count: null,
      };
      const runDelete = () => {
        if (executed) return result;
        const rows = applyFilters(db[table as keyof typeof db] ?? [], deleteFilters);
        const remaining = (db[table as keyof typeof db] ?? []).filter((r) => !rows.includes(r));
        if (table in db) (db as Record<string, StubRow[]>)[table] = remaining;
        executed = true;
        const deletedData = rows.map((r) => ({ id: (r as { id?: unknown }).id ?? null }));
        result = { data: deletedData, error: null, count: opts?.count ? rows.length : null };
        return result;
      };
      const chain = {
        eq(col: string, val: unknown) {
          deleteFilters.push({ col, val, op: "eq" });
          return chain;
        },
        lt(col: string, val: unknown) {
          deleteFilters.push({ col, val, op: "lt" });
          return chain;
        },
        in(col: string, vals: unknown[]) {
          deleteFilters.push({ col, val: [...vals], op: "in" });
          return chain;
        },
        select(): Promise<{ data: StubRow[]; error: null }> {
          const out = runDelete();
          return Promise.resolve({ data: out.data, error: null });
        },
        then<TResult1 = typeof result, TResult2 = never>(
          onfulfilled?: ((value: typeof result) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(runDelete()).then(onfulfilled, onrejected);
        },
      };
      return chain;
    },
    order() {
      return this;
    },
    range(from?: number, to?: number) {
      if (from !== undefined && to !== undefined) {
        const rows = applyFilters(db[table], filters).slice(from, to + 1);
        return makeResult(rows);
      }
      return this;
    },
  });

  return {
    from(table: string) {
      const mapped = table === "workspace_entitlements" ? "entitlements" : table;
      if (mapped === "api_audit_log") {
        const base = tableBuilder("api_audit_log" as keyof typeof db);
        return {
          insert: (payload: StubRow | StubRow[]) => base.insert(payload),
          delete: (opts?: { count?: "exact" }) => base.delete(opts),
          update: (values: Record<string, unknown>) => base.update(values),
          eq: (col: string, val: unknown) => base.eq(col, val),
          select(_cols?: string) {
            void _cols;
            return {
              eq(col: string, val: unknown) {
                if (col !== "workspace_id") {
                  const empty = { data: [] as StubRow[], error: null };
                  return {
                    order() {
                      return this;
                    },
                    range() {
                      return Promise.resolve(empty);
                    },
                  };
                }
                const wid = String(val);
                const sortedRows = () =>
                  [...db.api_audit_log]
                    .filter((r) => String(r.workspace_id) === wid)
                    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
                const chain = {
                  order(_c?: string, _o?: { ascending?: boolean }) {
                    void _c;
                    void _o;
                    return chain;
                  },
                  range(from: number, to: number) {
                    const rows = sortedRows();
                    const slice =
                      Number.isFinite(from) && Number.isFinite(to) && to >= from && from >= 0
                        ? rows.slice(from, to + 1)
                        : rows;
                    return Promise.resolve({ data: slice, error: null });
                  },
                };
                return chain;
              },
            };
          },
        };
      }
      return tableBuilder(mapped as keyof typeof db);
    },
    rpc(name: string, params: Record<string, unknown>) {
      switch (name) {
        case "bump_usage":
        case "bump_usage_rpc": {
          const existing = db.usage_daily.find(
            (r) => r.workspace_id === params.p_workspace_id && r.day === params.p_day,
          );
          if (existing) {
            existing.writes = (existing.writes as number) + (params.p_writes as number);
            existing.reads = (existing.reads as number) + (params.p_reads as number);
            existing.embeds = (existing.embeds as number) + (params.p_embeds as number);
            return Promise.resolve({ data: existing, error: null });
          }
          const row: Record<string, unknown> = {
            workspace_id: params.p_workspace_id,
            day: params.p_day,
            writes: params.p_writes,
            reads: params.p_reads,
            embeds: params.p_embeds,
            extraction_calls: 0,
            embed_tokens_used: 0,
          };
          db.usage_daily.push(row as StubRow);
          return Promise.resolve({ data: row, error: null });
        }
        case "bump_usage_if_within_cap": {
          const pW = (params.p_writes as number) ?? 0;
          const pR = (params.p_reads as number) ?? 0;
          const pE = (params.p_embeds as number) ?? 0;
          const pEt = (params.p_embed_tokens as number) ?? 0;
          const pEx = (params.p_extraction_calls as number) ?? 0;
          const capW = (params.p_writes_cap as number) ?? 0;
          const capR = (params.p_reads_cap as number) ?? 0;
          const capE = (params.p_embeds_cap as number) ?? 0;
          const capEt = (params.p_embed_tokens_cap as number) ?? 0;
          const capEx = (params.p_extraction_calls_cap as number) ?? 0;
          let existing = db.usage_daily.find(
            (r) => r.workspace_id === params.p_workspace_id && r.day === params.p_day,
          ) as Record<string, unknown> | undefined;
          if (!existing) {
            existing = {
              workspace_id: params.p_workspace_id,
              day: params.p_day,
              writes: 0,
              reads: 0,
              embeds: 0,
              extraction_calls: 0,
              embed_tokens_used: 0,
            };
            db.usage_daily.push(existing as StubRow);
          }
          const w = (existing.writes as number) ?? 0;
          const r = (existing.reads as number) ?? 0;
          const e = (existing.embeds as number) ?? 0;
          const et = (existing.embed_tokens_used as number) ?? 0;
          const ex = (existing.extraction_calls as number) ?? 0;
          if (w + pW > capW) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "writes" }], error: null });
          if (r + pR > capR) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "reads" }], error: null });
          if (e + pE > capE) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "embeds" }], error: null });
          if (et + pEt > capEt) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "embed_tokens" }], error: null });
          if (ex + pEx > capEx) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "extraction_calls" }], error: null });
          existing.writes = w + pW;
          existing.reads = r + pR;
          existing.embeds = e + pE;
          existing.embed_tokens_used = et + pEt;
          existing.extraction_calls = ex + pEx;
          return Promise.resolve({ data: [{ ...existing, exceeded: false, limit_name: null }], error: null });
        }
        case "record_usage_event_if_within_cap": {
          const pW = Number(params.p_writes ?? 0);
          const pR = Number(params.p_reads ?? 0);
          const pE = Number(params.p_embeds ?? 0);
          const pEt = Number(params.p_embed_tokens ?? 0);
          const pEx = Number(params.p_extraction_calls ?? 0);
          const capW = Number(params.p_writes_cap ?? Number.MAX_SAFE_INTEGER);
          const capR = Number(params.p_reads_cap ?? Number.MAX_SAFE_INTEGER);
          const capE = Number(params.p_embeds_cap ?? Number.MAX_SAFE_INTEGER);
          const capEt = Number(params.p_embed_tokens_cap ?? Number.MAX_SAFE_INTEGER);
          const capEx = Number(params.p_extraction_calls_cap ?? Number.MAX_SAFE_INTEGER);
          const day = String(params.p_day ?? todayUtc());
          let existing = db.usage_daily.find(
            (r) => r.workspace_id === params.p_workspace_id && r.day === day,
          ) as Record<string, unknown> | undefined;
          if (!existing) {
            existing = {
              workspace_id: params.p_workspace_id,
              day,
              writes: 0,
              reads: 0,
              embeds: 0,
              extraction_calls: 0,
              embed_tokens_used: 0,
              gen_input_tokens_used: 0,
              gen_output_tokens_used: 0,
              storage_bytes_used: 0,
            };
            db.usage_daily.push(existing as StubRow);
          }
          const w = Number(existing.writes ?? 0);
          const r = Number(existing.reads ?? 0);
          const e = Number(existing.embeds ?? 0);
          const et = Number(existing.embed_tokens_used ?? 0);
          const ex = Number(existing.extraction_calls ?? 0);
          if (w + pW > capW) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "writes" }], error: null });
          if (r + pR > capR) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "reads" }], error: null });
          if (e + pE > capE) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "embeds" }], error: null });
          if (et + pEt > capEt) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "embed_tokens" }], error: null });
          if (ex + pEx > capEx) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "extraction_calls" }], error: null });
          existing.writes = w + pW;
          existing.reads = r + pR;
          existing.embeds = e + pE;
          existing.embed_tokens_used = et + pEt;
          existing.extraction_calls = ex + pEx;
          const eventId = `ue_${Math.random().toString(36).slice(2, 10)}`;
          (db as unknown as { usage_events: StubRow[] }).usage_events.push({
            id: eventId,
            workspace_id: params.p_workspace_id,
            idempotency_key: params.p_idempotency_key,
          });
          return Promise.resolve({
            data: [{
              ...existing,
              exceeded: false,
              limit_name: null,
              usage_event_id: eventId,
              entitlement_id: null,
              idempotent_replay: false,
            }],
            error: null,
          });
        }
        case "create_usage_reservation": {
          const reservations = ((db as unknown as { usage_reservations?: StubRow[] }).usage_reservations ??= []);
          const id = `res_${Math.random().toString(36).slice(2, 12)}`;
          reservations.push({
            id,
            workspace_id: params.p_workspace_id as string,
            day: params.p_day as string,
            writes_delta: params.p_writes_delta as number,
            reads_delta: params.p_reads_delta as number,
            embeds_delta: params.p_embeds_delta as number,
            embed_tokens_delta: params.p_embed_tokens_delta as number,
            extraction_calls_delta: params.p_extraction_calls_delta as number,
            route: params.p_route as string | null,
            request_id: params.p_request_id as string | null,
            status: "reserved",
          } as unknown as StubRow);
          return Promise.resolve({ data: id, error: null });
        }
        case "reserve_usage_if_within_cap": {
          const reservations = ((db as unknown as { usage_reservations?: StubRow[] }).usage_reservations ??= []);
          const day = String(params.p_day ?? todayUtc());
          const workspaceId = String(params.p_workspace_id);
          const requestId = String(params.p_request_id ?? "");
          if (!requestId) {
            return Promise.resolve({ data: null, error: { message: "request_id required" } as unknown as { message: string } });
          }
          const existingReservation = reservations.find(
            (r) =>
              (r as { workspace_id?: string }).workspace_id === workspaceId &&
              (r as { request_id?: string | null }).request_id === requestId &&
              (r as { status?: string }).status !== "refunded",
          );
          if (existingReservation) {
            const routeMatches = String((existingReservation as { route?: string | null }).route ?? "") === String(params.p_route ?? "");
            const payloadMatches =
              Number((existingReservation as { writes_delta?: number }).writes_delta ?? 0) === Number(params.p_writes_delta ?? 0) &&
              Number((existingReservation as { reads_delta?: number }).reads_delta ?? 0) === Number(params.p_reads_delta ?? 0) &&
              Number((existingReservation as { embeds_delta?: number }).embeds_delta ?? 0) === Number(params.p_embeds_delta ?? 0) &&
              Number((existingReservation as { embed_tokens_delta?: number }).embed_tokens_delta ?? 0) === Number(params.p_embed_tokens_delta ?? 0) &&
              Number((existingReservation as { extraction_calls_delta?: number }).extraction_calls_delta ?? 0) === Number(params.p_extraction_calls_delta ?? 0);
            if (!routeMatches || !payloadMatches) {
              return Promise.resolve({ data: null, error: { message: "REQUEST_ID_CONFLICT" } as unknown as { message: string } });
            }
            return Promise.resolve({
              data: [{
                reservation_id: (existingReservation as { id?: string }).id ?? null,
                exceeded: false,
                limit_name: null,
                used_value: 0,
                cap_value: 0,
              }],
              error: null,
            });
          }
          const usage = db.usage_daily.find(
            (r) => r.workspace_id === workspaceId && r.day === day,
          ) ?? {
            workspace_id: workspaceId,
            day,
            writes: 0,
            reads: 0,
            embeds: 0,
            extraction_calls: 0,
            embed_tokens_used: 0,
          };
          const reserved = reservations
            .filter(
              (r) =>
                (r as { workspace_id?: string }).workspace_id === workspaceId &&
                (r as { status?: string }).status === "reserved",
            )
            .reduce<{ writes: number; reads: number; embeds: number; embed_tokens: number; extraction_calls: number }>(
              (acc, r) => {
                acc.writes += Number((r as { writes_delta?: number }).writes_delta ?? 0);
                acc.reads += Number((r as { reads_delta?: number }).reads_delta ?? 0);
                acc.embeds += Number((r as { embeds_delta?: number }).embeds_delta ?? 0);
                acc.embed_tokens += Number((r as { embed_tokens_delta?: number }).embed_tokens_delta ?? 0);
                acc.extraction_calls += Number((r as { extraction_calls_delta?: number }).extraction_calls_delta ?? 0);
                return acc;
              },
              { writes: 0, reads: 0, embeds: 0, embed_tokens: 0, extraction_calls: 0 },
            );
          const writes = Number(usage.writes ?? 0) + reserved.writes + Number(params.p_writes_delta ?? 0);
          const reads = Number(usage.reads ?? 0) + reserved.reads + Number(params.p_reads_delta ?? 0);
          const embeds = Number(usage.embeds ?? 0) + reserved.embeds + Number(params.p_embeds_delta ?? 0);
          const embedTokens = Number(usage.embed_tokens_used ?? 0) + reserved.embed_tokens + Number(params.p_embed_tokens_delta ?? 0);
          const extractionCalls = Number(usage.extraction_calls ?? 0) + reserved.extraction_calls + Number(params.p_extraction_calls_delta ?? 0);
          const costPerMinuteCap = Number(params.p_cost_per_minute_cap_inr ?? 0);
          if (Number.isFinite(costPerMinuteCap) && costPerMinuteCap > 0) {
            const minuteReservedCost = reservations
              .filter(
                (r) =>
                  (r as { workspace_id?: string }).workspace_id === workspaceId &&
                  (r as { status?: string }).status === "reserved",
              )
              .reduce((sum, r) => sum + Number((r as { estimated_cost_inr?: number }).estimated_cost_inr ?? 0), 0);
            const projected = minuteReservedCost + Number(params.p_estimated_cost_inr ?? 0);
            if (projected > costPerMinuteCap) {
              return Promise.resolve({
                data: [{
                  reservation_id: null,
                  exceeded: true,
                  limit_name: "cost_per_minute",
                  used_value: projected,
                  cap_value: costPerMinuteCap,
                }],
                error: null,
              });
            }
          }
          if (writes > Number(params.p_writes_cap ?? Number.MAX_SAFE_INTEGER)) {
            return Promise.resolve({ data: [{ reservation_id: null, exceeded: true, limit_name: "writes", used_value: writes, cap_value: Number(params.p_writes_cap ?? 0) }], error: null });
          }
          if (reads > Number(params.p_reads_cap ?? Number.MAX_SAFE_INTEGER)) {
            return Promise.resolve({ data: [{ reservation_id: null, exceeded: true, limit_name: "reads", used_value: reads, cap_value: Number(params.p_reads_cap ?? 0) }], error: null });
          }
          if (embeds > Number(params.p_embeds_cap ?? Number.MAX_SAFE_INTEGER)) {
            return Promise.resolve({ data: [{ reservation_id: null, exceeded: true, limit_name: "embeds", used_value: embeds, cap_value: Number(params.p_embeds_cap ?? 0) }], error: null });
          }
          if (embedTokens > Number(params.p_embed_tokens_cap ?? Number.MAX_SAFE_INTEGER)) {
            return Promise.resolve({ data: [{ reservation_id: null, exceeded: true, limit_name: "embed_tokens", used_value: embedTokens, cap_value: Number(params.p_embed_tokens_cap ?? 0) }], error: null });
          }
          if (extractionCalls > Number(params.p_extraction_calls_cap ?? Number.MAX_SAFE_INTEGER)) {
            return Promise.resolve({ data: [{ reservation_id: null, exceeded: true, limit_name: "extraction_calls", used_value: extractionCalls, cap_value: Number(params.p_extraction_calls_cap ?? 0) }], error: null });
          }
          const id = `res_${Math.random().toString(36).slice(2, 12)}`;
          reservations.push({
            id,
            workspace_id: workspaceId,
            day,
            writes_delta: Number(params.p_writes_delta ?? 0),
            reads_delta: Number(params.p_reads_delta ?? 0),
            embeds_delta: Number(params.p_embeds_delta ?? 0),
            embed_tokens_delta: Number(params.p_embed_tokens_delta ?? 0),
            extraction_calls_delta: Number(params.p_extraction_calls_delta ?? 0),
            estimated_cost_inr: Number(params.p_estimated_cost_inr ?? 0),
            internal_credits_total: Number(params.p_internal_credits_total ?? 0),
            route: params.p_route as string | null,
            request_id: requestId,
            idempotency_key: `${String(params.p_route ?? "unknown")}:${requestId}`,
            status: "reserved",
          } as unknown as StubRow);
          return Promise.resolve({
            data: [{ reservation_id: id, exceeded: false, limit_name: null, used_value: 0, cap_value: 0 }],
            error: null,
          });
        }
        case "commit_usage_reservation": {
          const reservations = ((db as unknown as { usage_reservations?: StubRow[] }).usage_reservations ??= []);
          const id = String(params.p_reservation_id ?? "");
          const row = reservations.find((r) => (r as { id?: string }).id === id) as Record<string, unknown> | undefined;
          if (!row) return Promise.resolve({ data: false, error: null });
          if (String(row.status ?? "") === "committed") return Promise.resolve({ data: true, error: null });
          row.status = "committed";
          row.committed_at = new Date().toISOString();
          const workspaceId = String(row.workspace_id ?? "");
          const day = String(row.day ?? todayUtc());
          let usage = db.usage_daily.find((u) => u.workspace_id === workspaceId && u.day === day);
          if (!usage) {
            usage = {
              workspace_id: workspaceId,
              day,
              writes: 0,
              reads: 0,
              embeds: 0,
              extraction_calls: 0,
              embed_tokens_used: 0,
            } as StubRow;
            db.usage_daily.push(usage);
          }
          usage.writes = Number(usage.writes ?? 0) + Number(row.writes_delta ?? 0);
          usage.reads = Number(usage.reads ?? 0) + Number(row.reads_delta ?? 0);
          usage.embeds = Number(usage.embeds ?? 0) + Number(row.embeds_delta ?? 0);
          usage.extraction_calls = Number(usage.extraction_calls ?? 0) + Number(row.extraction_calls_delta ?? 0);
          usage.embed_tokens_used = Number(usage.embed_tokens_used ?? 0) + Number(row.embed_tokens_delta ?? 0);
          return Promise.resolve({ data: true, error: null });
        }
        case "mark_usage_reservation_committed": {
          const reservations = ((db as unknown as { usage_reservations?: StubRow[] }).usage_reservations ??= []);
          const id = params.p_reservation_id as string;
          const row = reservations.find((r) => (r as { id?: string }).id === id);
          if (row) (row as { status?: string }).status = "committed";
          return Promise.resolve({ data: Boolean(row), error: null });
        }
        case "mark_usage_reservation_refund_pending": {
          const reservations = ((db as unknown as { usage_reservations?: StubRow[] }).usage_reservations ??= []);
          const id = params.p_reservation_id as string;
          const row = reservations.find((r) => (r as { id?: string }).id === id);
          if (row) {
            (row as { status?: string }).status = "refund_pending";
            (row as { error_message?: string }).error_message = (params.p_error_message as string) ?? null;
          }
          return Promise.resolve({ data: Boolean(row), error: null });
        }
        case "process_usage_reservation_refunds": {
          const reservations = ((db as unknown as { usage_reservations?: StubRow[] }).usage_reservations ??= []);
          const limit = Number(params.p_limit ?? 100);
          const rows = reservations
            .filter((r) => (r as { status?: string }).status === "refund_pending")
            .slice(0, Math.max(1, Math.min(1000, limit)));
          for (const row of rows) {
            const workspaceId = (row as { workspace_id?: string }).workspace_id as string;
            const day = (row as { day?: string }).day as string;
            const usage = db.usage_daily.find((u) => u.workspace_id === workspaceId && u.day === day);
            if (usage) {
              usage.writes = Math.max(0, Number(usage.writes ?? 0) - Number((row as { writes_delta?: number }).writes_delta ?? 0));
              usage.reads = Math.max(0, Number(usage.reads ?? 0) - Number((row as { reads_delta?: number }).reads_delta ?? 0));
              usage.embeds = Math.max(0, Number(usage.embeds ?? 0) - Number((row as { embeds_delta?: number }).embeds_delta ?? 0));
              usage.embed_tokens_used = Math.max(
                0,
                Number(usage.embed_tokens_used ?? 0) - Number((row as { embed_tokens_delta?: number }).embed_tokens_delta ?? 0),
              );
              usage.extraction_calls = Math.max(
                0,
                Number(usage.extraction_calls ?? 0) - Number((row as { extraction_calls_delta?: number }).extraction_calls_delta ?? 0),
              );
            }
            (row as { status?: string }).status = "refunded";
          }
          return Promise.resolve({
            data: rows.map((r) => ({
              reservation_id: (r as { id?: string }).id ?? null,
              workspace_id: (r as { workspace_id?: string }).workspace_id ?? null,
              day: (r as { day?: string }).day ?? null,
              status: (r as { status?: string }).status ?? null,
              error_message: (r as { error_message?: string }).error_message ?? null,
            })),
            error: null,
          });
        }
        case "workspace_pruning_metrics": {
          const ws = params.p_workspace_id as string;
          const memories = db.memories.filter((m) => m.workspace_id === ws);
          const memoriesTotal = memories.length;
          const dup = memories.filter((m) => (m as { duplicate_of?: unknown }).duplicate_of != null).length;
          const chunks = db.memory_chunks.filter((c) => c.workspace_id === ws).length;
          return Promise.resolve({
            data: [
              {
                memories_total: memoriesTotal,
                memories_marked_duplicate: dup,
                memory_chunks_total: chunks,
              },
            ],
            error: null,
          });
        }
        case "bump_memory_retrieval_counts": {
          const ws = params.p_workspace_id as string;
          const ids = (params.p_memory_ids as string[] | null) ?? [];
          for (const id of ids) {
            const m = db.memories.find((row) => row.workspace_id === ws && row.id === id) as
              | (StubRow & { retrieval_count?: number })
              | undefined;
            if (m) m.retrieval_count = Number(m.retrieval_count ?? 0) + 1;
          }
          return Promise.resolve({ data: null, error: null });
        }
        case "match_chunks_vector":
        case "match_chunks_text": {
          const memoryTypes = params.p_memory_types as string[] | null;
          const filterMode = (params.p_filter_mode as string) ?? "and";
          const metaFilter = params.p_metadata as Record<string, unknown> | null;

          let chunks = db.memory_chunks.filter(
            (c) =>
              c.workspace_id === params.p_workspace_id &&
              c.user_id === params.p_user_id &&
              c.namespace === params.p_namespace,
          );

          if (memoryTypes && memoryTypes.length > 0) {
            const memoryIdSet = new Set(
              db.memories
                .filter((m) =>
                  m.workspace_id === params.p_workspace_id &&
                  m.duplicate_of == null &&
                  typeof m.memory_type === "string" &&
                  memoryTypes.includes(m.memory_type as string),
                )
                .map((m) => m.id),
            );
            chunks = chunks.filter((c) => memoryIdSet.has(c.memory_id));
          } else {
            const nonDupIds = new Set(
              db.memories
                .filter((m) => m.workspace_id === params.p_workspace_id && m.duplicate_of == null)
                .map((m) => m.id),
            );
            chunks = chunks.filter((c) => nonDupIds.has(c.memory_id));
          }

          if (metaFilter && Object.keys(metaFilter).length > 0) {
            const matchingMemoryIds = new Set(
              db.memories
                .filter((m) => {
                  if (m.workspace_id !== params.p_workspace_id) return false;
                  const meta = (m.metadata ?? {}) as Record<string, unknown>;
                  const entries = Object.entries(metaFilter);
                  return filterMode === "or"
                    ? entries.some(([k, v]) => meta[k] === v)
                    : entries.every(([k, v]) => meta[k] === v);
                })
                .map((m) => m.id),
            );
            chunks = chunks.filter((c) => matchingMemoryIds.has(c.memory_id));
          }

          const q = (params.p_query as string | undefined)?.toLowerCase() ?? "";
          const memById = new Map(
            db.memories
              .filter((m) => m.workspace_id === params.p_workspace_id)
              .map((m) => [m.id as string, m as StubRow & { importance?: number; retrieval_count?: number }]),
          );
          const results = chunks
            .filter((c) => (c.chunk_text as string).toLowerCase().includes(q))
            .slice(0, Number(params.p_match_count ?? 20))
            .map((c, idx) => {
              const mem = memById.get(c.memory_id as string);
              const imp = typeof mem?.importance === "number" ? Math.max(mem.importance, 0.01) : 1;
              const rc = typeof mem?.retrieval_count === "number" ? Math.max(0, mem.retrieval_count) : 0;
              const freq = 1 + Math.min(Math.log(1 + rc) / 18, 0.45);
              return {
                chunk_id: c.id as string,
                memory_id: c.memory_id as string,
                chunk_index: c.chunk_index as number,
                chunk_text: c.chunk_text as string,
                score: (1 / (idx + 1)) * imp * freq,
              };
            });
          return Promise.resolve({ data: results, error: null });
        }
        case "dashboard_console_overview_stats": {
          const ws = params.p_workspace_id as string;
          const memSince = params.p_memories_since as string | null | undefined;
          const dayMin = params.p_usage_day_min as string | null | undefined;
          const memSinceMs = memSince ? Date.parse(memSince) : null;

          let documents = 0;
          for (const m of db.memories) {
            if ((m as { workspace_id?: string }).workspace_id !== ws) continue;
            if (memSinceMs != null && Number.isFinite(memSinceMs)) {
              const ca = Date.parse(String((m as { created_at?: string }).created_at ?? ""));
              if (!Number.isFinite(ca) || ca < memSinceMs) continue;
            }
            documents++;
          }

          let memories = 0;
          for (const c of db.memory_chunks) {
            if ((c as { workspace_id?: string }).workspace_id !== ws) continue;
            if (memSinceMs != null && Number.isFinite(memSinceMs)) {
              const ca = Date.parse(String((c as { created_at?: string }).created_at ?? ""));
              if (!Number.isFinite(ca) || ca < memSinceMs) continue;
            }
            memories++;
          }

          let search_requests = 0;
          for (const u of db.usage_daily) {
            if ((u as { workspace_id?: string }).workspace_id !== ws) continue;
            if (dayMin) {
              const ud = String((u as { day?: string }).day ?? "").slice(0, 10);
              if (ud < dayMin) continue;
            }
            search_requests += Number((u as { reads?: number }).reads ?? 0) || 0;
          }

          const tagSet = new Set<string>();
          for (const m of db.memories) {
            if ((m as { workspace_id?: string }).workspace_id !== ws) continue;
            if (memSinceMs != null && Number.isFinite(memSinceMs)) {
              const ca = Date.parse(String((m as { created_at?: string }).created_at ?? ""));
              if (!Number.isFinite(ca) || ca < memSinceMs) continue;
            }
            const meta = ((m as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
            const ct = meta.container_tag;
            const cn = meta.container;
            if (typeof ct === "string" && ct.trim()) tagSet.add(ct.trim());
            if (typeof cn === "string" && cn.trim()) tagSet.add(cn.trim());
          }

          return Promise.resolve({
            data: {
              documents,
              memories,
              search_requests,
              container_tags: tagSet.size,
            },
            error: null,
          });
        }
        case "list_memories_scoped": {
          const workspaceId = params.p_workspace_id as string;
          const page = Math.max(1, Number(params.p_page ?? 1));
          const pageSize = Math.max(1, Number(params.p_page_size ?? 20));
          const namespace = (params.p_namespace as string | null | undefined) ?? null;
          const userId = (params.p_user_id as string | null | undefined) ?? null;
          const memoryType = (params.p_memory_type as string | null | undefined) ?? null;
          const metadataFilter = (params.p_metadata as Record<string, unknown> | null | undefined) ?? null;
          const startTime = (params.p_start_time as string | null | undefined) ?? null;
          const endTime = (params.p_end_time as string | null | undefined) ?? null;

          let rows = db.memories.filter((m) =>
            m.workspace_id === workspaceId &&
            m.duplicate_of == null &&
            (namespace == null || m.namespace === namespace) &&
            (userId == null || m.user_id === userId) &&
            (memoryType == null || m.memory_type === memoryType),
          );
          if (metadataFilter && Object.keys(metadataFilter).length > 0) {
            rows = rows.filter((m) => {
              const meta = (m.metadata ?? {}) as Record<string, unknown>;
              return Object.entries(metadataFilter).every(([k, v]) => meta[k] === v);
            });
          }
          if (startTime) rows = rows.filter((m) => String(m.created_at) >= startTime);
          if (endTime) rows = rows.filter((m) => String(m.created_at) <= endTime);

          rows = rows
            .slice()
            .sort((a, b) => {
              const ca = String(a.created_at ?? "");
              const cb = String(b.created_at ?? "");
              if (ca === cb) return String(b.id ?? "").localeCompare(String(a.id ?? ""));
              return cb.localeCompare(ca);
            });

          const totalCount = rows.length;
          const offset = (page - 1) * pageSize;
          const paged = rows.slice(offset, offset + pageSize + 1).map((m) => ({
            id: m.id as string,
            workspace_id: m.workspace_id as string,
            user_id: m.user_id as string,
            namespace: m.namespace as string,
            text: m.text as string,
            metadata: (m.metadata ?? {}) as Record<string, unknown>,
            created_at: m.created_at as string,
            memory_type: (m.memory_type as string | null | undefined) ?? null,
            source_memory_id: (m.source_memory_id as string | null | undefined) ?? null,
            importance: typeof (m as { importance?: number }).importance === "number"
              ? (m as { importance: number }).importance
              : 1,
            retrieval_count: typeof (m as { retrieval_count?: number }).retrieval_count === "number"
              ? Number((m as { retrieval_count: number }).retrieval_count)
              : 0,
            total_count: totalCount,
          }));

          return Promise.resolve({ data: paged, error: null });
        }
        case "get_memory_scoped": {
          const workspaceId = params.p_workspace_id as string;
          const memoryId = params.p_memory_id as string;
          const row = db.memories.find((m) => m.workspace_id === workspaceId && m.id === memoryId);
          if (!row) return Promise.resolve({ data: [], error: null });
          return Promise.resolve({
            data: [{
              id: row.id as string,
              workspace_id: row.workspace_id as string,
              user_id: row.user_id as string,
              namespace: row.namespace as string,
              text: row.text as string,
              metadata: (row.metadata ?? {}) as Record<string, unknown>,
              created_at: row.created_at as string,
              memory_type: (row.memory_type as string | null | undefined) ?? null,
              source_memory_id: (row.source_memory_id as string | null | undefined) ?? null,
              importance: typeof (row as { importance?: number }).importance === "number"
                ? (row as { importance: number }).importance
                : 1,
              retrieval_count: typeof (row as { retrieval_count?: number }).retrieval_count === "number"
                ? Number((row as { retrieval_count: number }).retrieval_count)
                : 0,
            }],
            error: null,
          });
        }
        case "delete_memory_scoped": {
          const workspaceId = params.p_workspace_id as string;
          const memoryId = params.p_memory_id as string;
          const beforeMemCount = db.memories.length;
          db.memory_chunks = db.memory_chunks.filter((c) => !(c.workspace_id === workspaceId && c.memory_id === memoryId));
          db.memories = db.memories.filter((m) => !(m.workspace_id === workspaceId && m.id === memoryId));
          const deleted = db.memories.length < beforeMemCount;
          return Promise.resolve({ data: [{ deleted }], error: null });
        }
        default:
          return Promise.resolve({ data: null, error: null });
      }
    },
    __rawApiKeys: rawApiKeys,
    __db: db,
  };
}

async function safeParseJson<T>(request: Request): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = (await request.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
}

export { parseAllowedOrigins, isOriginAllowed, makeCorsHeaders } from "./cors.js";

export async function assertBodySize(request: Request, env: Env, overrideLimit?: number): Promise<void> {
  const limit = overrideLimit ?? Number(env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES);
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > limit) {
    throw createHttpError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
  }
  if (request.body) {
    const clone = request.clone();
    const reader = clone.body!.getReader();
    let received = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.length ?? 0;
      if (received > limit) {
        throw createHttpError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
      }
    }
  }
}

export { emitAuditLog } from "./audit.js";

function b64encode(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  const btoaFn = (globalThis as { btoa?: typeof btoa }).btoa as typeof btoa;
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoaFn(binary);
}

function b64decode(input: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(input, "base64"));
  }
  const atobFn = (globalThis as { atob?: typeof atob }).atob as typeof atob;
  const binary = atobFn(input);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type ExportManifest = {
  version: 1;
  workspace_id: string;
  generated_at: string;
  files: Array<{ name: string; sha256: string; size: number }>;
  counts: { memories: number; chunks: number };
};

export async function buildExportArtifact(
  auth: AuthContext,
  supabase: SupabaseClient,
  maxBytes = DEFAULT_MAX_EXPORT_BYTES,
): Promise<ExportOutcome> {
  const memRes = await supabase
    .from("memories")
    .select("id, user_id, namespace, text, metadata, created_at", { count: "exact" })
    .eq("workspace_id", auth.workspaceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (memRes.error) throw createHttpError(500, "DB_ERROR", memRes.error.message ?? "Failed to export memories");

  const chunkRes = await supabase
    .from("memory_chunks")
    .select("id, memory_id, user_id, namespace, chunk_index, chunk_text, embedding, created_at", { count: "exact" })
    .eq("workspace_id", auth.workspaceId)
    .order("memory_id")
    .order("chunk_index");
  if (chunkRes.error)
    throw createHttpError(500, "DB_ERROR", chunkRes.error.message ?? "Failed to export memory chunks");

  const memories = memRes.data ?? [];
  const chunks = chunkRes.data ?? [];

  const memNdjson = memories.map((m) => JSON.stringify(m)).join("\n");
  const chunkNdjson = chunks.map((c) => JSON.stringify(c)).join("\n");

  const files: Array<{ name: string; sha256: string; size: number; content: Uint8Array }> = [];
  const memBytes = new TextEncoder().encode(memNdjson);
  files.push({ name: "memories.ndjson", size: memBytes.length, content: memBytes, sha256: await sha256HexBytes(memBytes) });
  const chunkBytes = new TextEncoder().encode(chunkNdjson);
  files.push({
    name: "chunks.ndjson",
    size: chunkBytes.length,
    content: chunkBytes,
    sha256: await sha256HexBytes(chunkBytes),
  });

  const manifest: ExportManifest = {
    version: 1,
    workspace_id: auth.workspaceId,
    generated_at: new Date(0).toISOString(),
    counts: { memories: memories.length, chunks: chunks.length },
    files: files.map((f) => ({ name: f.name, sha256: f.sha256, size: f.size })).sort((a, b) => a.name.localeCompare(b.name)),
  };

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  files.push({ name: "manifest.json", size: manifestBytes.length, content: manifestBytes, sha256: await sha256HexBytes(manifestBytes) });

  const zip = new JSZip();
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    zip.file(f.name, f.content, { date: new Date(0) });
  }
  const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
  if (archive.length > maxBytes) {
    throw createHttpError(413, "payload_too_large", `export exceeds ${maxBytes} bytes`);
  }
  const sha = await sha256HexBytes(archive);
  return { artifact_base64: b64encode(archive), bytes: archive.length, sha256: sha, archive };
}

export function wantsZipResponse(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.searchParams.get("format")?.toLowerCase() === "zip" ||
    (request.headers.get("accept") ?? "").toLowerCase().includes("application/zip")
  );
}

export async function importArtifact(
  auth: AuthContext,
  supabase: SupabaseClient,
  artifactBase64: string,
  maxBytes: number,
  mode: ImportMode = "upsert",
  options?: {
    preInsertGuard?: (deltas: {
      writesDelta: number;
      readsDelta: number;
      embedsDelta: number;
      embedTokensDelta: number;
      extractionCallsDelta: number;
    }) => Promise<{ response: Response | null; reservationId: string | null }>;
  },
): Promise<ImportOutcome | { cap_exceeded: true; response: Response } | { failed: true; response: Response; reservation_id: string | null } | (ImportOutcome & { reservation_id: string | null })> {
  const allowedModes: ImportMode[] = ["upsert", "skip_existing", "error_on_conflict", "replace_ids", "replace_all"];
  if (!allowedModes.includes(mode)) {
    throw createHttpError(400, "BAD_REQUEST", "invalid import mode");
  }

  const zipBytes = b64decode(artifactBase64);
  if (zipBytes.length > maxBytes) {
    throw createHttpError(413, "payload_too_large", `artifact exceeds ${maxBytes} bytes`);
  }
  const zip = await JSZip.loadAsync(zipBytes);
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw createHttpError(400, "BAD_REQUEST", "manifest.json missing");
  const manifestText = await manifestEntry.async("string");
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(manifestText) as ExportManifest;
  } catch {
    throw createHttpError(400, "BAD_REQUEST", "manifest.json invalid");
  }
  if (manifest.workspace_id !== auth.workspaceId) {
    throw createHttpError(403, "FORBIDDEN", "Artifact workspace mismatch");
  }
  if (manifest.version !== 1) throw createHttpError(400, "BAD_REQUEST", "Unsupported manifest version");

  const readFileChecked = async (name: string) => {
    const entry = zip.file(name);
    if (!entry) throw createHttpError(400, "BAD_REQUEST", `${name} missing`);
    const bytes = new Uint8Array(await entry.async("uint8array"));
    const sha = await sha256HexBytes(bytes);
    const declared = manifest.files.find((f) => f.name === name);
    if (!declared || declared.sha256 !== sha) {
      throw createHttpError(400, "BAD_REQUEST", `${name} checksum mismatch`);
    }
    return bytes;
  };

  const memBytes = await readFileChecked("memories.ndjson");
  const chunkBytes = await readFileChecked("chunks.ndjson");

  const parseNdjson = (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes).trim() === ""
      ? []
      : new TextDecoder()
          .decode(bytes)
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));

  const memories = parseNdjson(memBytes).map((m) => ({ ...m, workspace_id: auth.workspaceId }));
  const chunks = parseNdjson(chunkBytes).map((c) => ({ ...c, workspace_id: auth.workspaceId }));

  const memIds = memories.map((m) => m.id);
  const chunkIds = chunks.map((c) => c.id);

  const fetchExistingIds = async (table: "memories" | "memory_chunks", ids: string[]): Promise<Set<string>> => {
    if (!ids.length) return new Set<string>();
    const { data, error } = await supabase
      .from(table)
      .select("id")
      .eq("workspace_id", auth.workspaceId)
      .in("id", ids);
    if (error) {
      throw createHttpError(500, "DB_ERROR", error.message ?? `Failed to check existing ${table}`);
    }
    return new Set((data ?? []).map((r: { id: string }) => r.id));
  };

  const ensureOk = (result: { error: { message?: string } | null }, fallback: string) => {
    if (result.error) throw createHttpError(500, "DB_ERROR", result.error.message ?? fallback);
  };

  let memoriesToWrite = memories;
  let chunksToWrite = chunks;

  if (mode === "error_on_conflict") {
    const existingMemIds = await fetchExistingIds("memories", memIds);
    const existingChunkIds = await fetchExistingIds("memory_chunks", chunkIds);
    if (existingMemIds.size > 0 || existingChunkIds.size > 0) {
      throw createHttpError(409, "CONFLICT", "Import conflicts with existing ids");
    }
  }

  if (mode === "skip_existing") {
    const existingMemIds = await fetchExistingIds("memories", memIds);
    memoriesToWrite = memories.filter((m) => !existingMemIds.has(m.id));
    const allowedMemoryIds = new Set(memoriesToWrite.map((m) => m.id));
    const existingChunkIds = await fetchExistingIds("memory_chunks", chunkIds);
    chunksToWrite = chunks.filter((c) => !existingChunkIds.has(c.id) && allowedMemoryIds.has(c.memory_id));
  }

  if (mode === "replace_all") {
    const delChunks = await supabase.from("memory_chunks").delete().eq("workspace_id", auth.workspaceId);
    ensureOk(delChunks, "Failed to clear chunks");
    const delMems = await supabase.from("memories").delete().eq("workspace_id", auth.workspaceId);
    ensureOk(delMems, "Failed to clear memories");
  }

  if (mode === "replace_ids") {
    if (memories.length > 0) {
      const delChunks = await supabase.from("memory_chunks").delete().eq("workspace_id", auth.workspaceId).in("memory_id", memIds);
      ensureOk(delChunks, "Failed to delete chunks by id");
      const delMems = await supabase.from("memories").delete().eq("workspace_id", auth.workspaceId).in("id", memIds);
      ensureOk(delMems, "Failed to delete memories by id");
    }
  }

  const writesDelta = memoriesToWrite.length;
  const embedsDelta = chunksToWrite.length;
  const embedTokensDelta = chunksToWrite.reduce(
    (sum, c) => sum + estimateEmbedTokens(String((c as { chunk_text?: string }).chunk_text ?? "").length),
    0,
  );
  let reservationId: string | null = null;
  if (options?.preInsertGuard) {
    const guard = await options.preInsertGuard({
      writesDelta,
      readsDelta: 0,
      embedsDelta,
      embedTokensDelta,
      extractionCallsDelta: 0,
    });
    reservationId = guard.reservationId;
    if (guard.response) return { cap_exceeded: true, response: guard.response };
  }

  let importedMemories = 0;
  let importedChunks = 0;

  if (memoriesToWrite.length > 0) {
    if (mode === "upsert") {
      const res = await supabase.from("memories").upsert(memoriesToWrite, { onConflict: "id" });
      ensureOk(res, "Failed to import memories");
    } else {
      const res = await supabase.from("memories").insert(memoriesToWrite);
      ensureOk(res, "Failed to import memories");
    }
    importedMemories = memoriesToWrite.length;
  }

  if (chunksToWrite.length > 0) {
    if (mode === "upsert") {
      const res = await supabase.from("memory_chunks").upsert(chunksToWrite, { onConflict: "id" });
      ensureOk(res, "Failed to import chunks");
    } else {
      const res = await supabase.from("memory_chunks").insert(chunksToWrite);
      ensureOk(res, "Failed to import chunks");
    }
    importedChunks = chunksToWrite.length;
  }

  return { imported_memories: importedMemories, imported_chunks: importedChunks, reservation_id: reservationId };
}


export function chunkText(text: string, chunkSize = 800, overlap = 100): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);

  const pushChunk = (chunk: string) => {
    const trimmed = chunk.trim();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
  };

  let buffer = "";
  const flushBuffer = () => {
    if (buffer.trim().length > 0) {
      pushChunk(buffer);
      buffer = "";
    }
  };

  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      flushBuffer();
      let start = 0;
      while (start < para.length) {
        const end = Math.min(start + chunkSize, para.length);
        pushChunk(para.slice(start, end));
        if (end === para.length) break;
        start = Math.max(end - overlap, start + 1);
      }
      continue;
    }

    if (buffer.length === 0) {
      buffer = para;
      continue;
    }

    const candidate = `${buffer}\n\n${para}`;
    if (candidate.length <= chunkSize) {
      buffer = candidate;
    } else {
      flushBuffer();
      buffer = para;
    }
  }

  flushBuffer();
  return chunks;
}

export function chunkTextWithProfile(text: string, profile?: ChunkProfile): string[] {
  const { chunkSize, overlap } = chunkParamsForProfile(profile);
  return chunkText(text, chunkSize, overlap);
}

function effectiveEmbeddingModelLabelForHealth(env: Env): string {
  const mode = (env.EMBEDDINGS_MODE ?? "openai").toLowerCase();
  if (mode === "stub") return "stub";
  const trimmed = (env.EMBEDDING_MODEL ?? "text-embedding-3-small").trim();
  return trimmed.length > 0 ? trimmed : "text-embedding-3-small";
}

const EMBED_MAX_RETRIES = RETRY_MAX_ATTEMPTS;
const EMBED_RETRY_DELAYS_MS = OPENAI_EMBED_RETRY_DELAYS_MS;

/** Retry fetch on 5xx, 429, or network error. Does not retry on 4xx (except 429). Request-level timeout per attempt. */
async function fetchWithRetry(
  url: string,
  init: RequestInit & { body: string },
  options?: { maxRetries?: number; delaysMs?: number[]; timeoutMs?: number },
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? EMBED_MAX_RETRIES;
  const delaysMs = options?.delaysMs ?? EMBED_RETRY_DELAYS_MS;
  const timeoutMs = options?.timeoutMs ?? EMBED_REQUEST_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    const signal = controller.signal;
    try {
      const res = await fetch(url, { ...init, signal, body: init.body });
      if (timeoutId) clearTimeout(timeoutId);
      const retryable = res.status === 429 || res.status >= 500;
      if (!res.ok && !retryable) return res;
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
      if (attempt < maxRetries) {
        const delayMs = delaysMs[attempt] ?? 1000;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      lastError = err;
      if (attempt < maxRetries) {
        const delayMs = delaysMs[attempt] ?? 1000;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

export interface EmbedResult {
  embeddings: number[][];
  tokensUsed: number;
}

async function embedText(texts: string[], env: Env): Promise<EmbedResult> {
  const mode = (env.EMBEDDINGS_MODE || "openai").toLowerCase();
  if (mode === "stub") {
    const estimatedTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    return { embeddings: texts.map((t) => stubEmbedding(t)), tokensUsed: estimatedTokens };
  }

  if (!env.OPENAI_API_KEY) {
    throw createHttpError(500, "CONFIG_ERROR", "OPENAI_API_KEY not set");
  }

  const modelRaw = (env.EMBEDDING_MODEL ?? "text-embedding-3-small").trim();
  const model = modelRaw.length > 0 ? modelRaw : "text-embedding-3-small";
  const bodyPayload: { model: string; input: string[]; dimensions?: number } = { model, input: texts };
  if (model === "text-embedding-3-large") {
    bodyPayload.dimensions = 1536;
  }

  const embedStart = Date.now();
  const body = JSON.stringify(bodyPayload);
  let response: Response;
  try {
    response = await withCircuitBreaker("openai", () =>
      fetchWithRetry(
        "https://api.openai.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body,
        },
        { timeoutMs: EMBED_REQUEST_TIMEOUT_MS },
      ),
    env,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("CIRCUIT_OPEN:")) {
      throw createHttpError(503, "SERVICE_UNAVAILABLE", "Embedding service temporarily unavailable");
    }
    throw err;
  }

  if (!response.ok) {
    const embedLatency = Date.now() - embedStart;
    const rawErrorBody = await response.text();
    logger.error({
      event: "embed_request",
      embed_latency_ms: embedLatency,
      embed_count: texts.length,
      status: response.status,
      success: false,
      embedding_model: model,
      upstream_error: redact(rawErrorBody, "upstream_error"),
    });
    throw createHttpError(500, "EMBED_ERROR", `Embedding service returned HTTP ${response.status}`);
  }

  const json = (await response.json()) as {
    data: { embedding: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };

  const tokensUsed = json.usage?.total_tokens ?? texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);

  const embedLatency = Date.now() - embedStart;
  logger.info({
    event: "embed_request",
    embed_latency_ms: embedLatency,
    embed_count: texts.length,
    tokens_used: tokensUsed,
    status: response.status,
    success: true,
    embedding_model: model,
  });

  if (!json.data || json.data.length !== texts.length) {
    throw createHttpError(500, "EMBED_ERROR", "Embedding response missing data");
  }

  return { embeddings: json.data.map((item) => item.embedding), tokensUsed };
}

function vectorToPgvectorString(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

type MatchResult = {
  chunk_id: string;
  memory_id: string;
  chunk_index: number;
  chunk_text: string;
  score: number;
};

type FusionResult = {
  chunk_id: string;
  memory_id: string;
  chunk_index: number;
  text: string;
  score: number;
  _explain?: {
    rrf_score: number;
    match_sources: ("vector" | "text")[];
    vector_score?: number;
    text_score?: number;
  };
};

async function callMatchVector(
  supabase: SupabaseClient,
  args: {
    workspaceId: string;
    userId: string;
    namespace: string;
    queryEmbedding: string;
    matchCount: number;
    metadata?: MetadataFilter;
    startTime?: string;
    endTime?: string;
    memoryTypes?: string[];
    filterMode?: string;
  },
): Promise<MatchResult[]> {
  const rpcStart = Date.now();
  const { data, error } = await supabase.rpc("match_chunks_vector", {
    p_workspace_id: args.workspaceId,
    p_user_id: args.userId,
    p_namespace: args.namespace,
    p_query_embedding: args.queryEmbedding,
    p_match_count: args.matchCount,
    p_metadata: args.metadata ?? null,
    p_start_time: args.startTime ?? null,
    p_end_time: args.endTime ?? null,
    p_memory_types: args.memoryTypes ?? null,
    p_filter_mode: args.filterMode ?? "and",
  });
  const dbLatency = Date.now() - rpcStart;

  if (error) {
    logger.error({
      event: "db_rpc",
      rpc: "match_chunks_vector",
      db_latency_ms: dbLatency,
      success: false,
    });
    throw createHttpError(500, "DB_ERROR", `match_chunks_vector failed: ${error.message}`);
  }
  logger.info({
    event: "db_rpc",
    rpc: "match_chunks_vector",
    db_latency_ms: dbLatency,
    result_count: (data ?? []).length,
    success: true,
  });
  return (data ?? []) as MatchResult[];
}

/**
 * Update last_accessed_at for chunks returned in search. Fire-and-forget only; never await.
 * Enforces workspace_id. Swallows errors.
 */
function bumpChunkAccess(
  supabase: SupabaseClient,
  workspaceId: string,
  chunkIds: string[],
): void {
  if (chunkIds.length === 0) return;
  const p = supabase
    .from("memory_chunks")
    .update({ last_accessed_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .in("id", chunkIds);
  void Promise.resolve(p).catch(() => {});
}

/** Fire-and-forget: increments memories.retrieval_count for rows shown in search results. */
function bumpMemoryRetrievalCounts(supabase: SupabaseClient, workspaceId: string, memoryIds: string[]): void {
  const uniq = [...new Set(memoryIds)].filter(Boolean);
  if (uniq.length === 0) return;
  void Promise.resolve(
    supabase.rpc("bump_memory_retrieval_counts", {
      p_workspace_id: workspaceId,
      p_memory_ids: uniq,
    }),
  ).catch(() => {});
}

async function callMatchText(
  supabase: SupabaseClient,
  args: {
    workspaceId: string;
    userId: string;
    namespace: string;
    query: string;
    matchCount: number;
    metadata?: MetadataFilter;
    startTime?: string;
    endTime?: string;
    memoryTypes?: string[];
    filterMode?: string;
  },
): Promise<MatchResult[]> {
  const rpcStart = Date.now();
  const { data, error } = await supabase.rpc("match_chunks_text", {
    p_workspace_id: args.workspaceId,
    p_user_id: args.userId,
    p_namespace: args.namespace,
    p_query: args.query,
    p_match_count: args.matchCount,
    p_metadata: args.metadata ?? null,
    p_start_time: args.startTime ?? null,
    p_end_time: args.endTime ?? null,
    p_memory_types: args.memoryTypes ?? null,
    p_filter_mode: args.filterMode ?? "and",
  });
  const dbLatency = Date.now() - rpcStart;
  if (error) {
    logger.error({
      event: "db_rpc",
      rpc: "match_chunks_text",
      db_latency_ms: dbLatency,
      success: false,
    });
    throw createHttpError(500, "DB_ERROR", `match_chunks_text failed: ${error.message}`);
  }
  logger.info({
    event: "db_rpc",
    rpc: "match_chunks_text",
    db_latency_ms: dbLatency,
    result_count: (data ?? []).length,
    success: true,
  });
  return (data ?? []) as MatchResult[];
}

function reciprocalRankFusion(
  vectorResults: MatchResult[],
  textResults: MatchResult[],
  topK: number,
  includeExplain: boolean,
): FusionResult[] {
  const scores = new Map<
    string,
    FusionResult & { rrf: number; vectorScore?: number; textScore?: number; matchSources: ("vector" | "text")[] }
  >();

  const applyList = (list: MatchResult[], source: "vector" | "text") => {
    list.forEach((item, idx) => {
      const rrfScore = 1 / (RRF_K + idx + 1);
      const existing = scores.get(item.chunk_id);
      const combinedScore = (existing?.rrf ?? 0) + rrfScore;
      const matchSources = existing?.matchSources ?? [];
      if (!matchSources.includes(source)) matchSources.push(source);
      scores.set(item.chunk_id, {
        chunk_id: item.chunk_id,
        memory_id: item.memory_id,
        chunk_index: item.chunk_index,
        text: item.chunk_text,
        score: combinedScore,
        rrf: combinedScore,
        ...(source === "vector"
          ? { vectorScore: item.score, textScore: existing?.textScore }
          : { vectorScore: existing?.vectorScore, textScore: item.score }),
        matchSources,
      });
    });
  };

  applyList(vectorResults, "vector");
  applyList(textResults, "text");

  return Array.from(scores.values())
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (Math.abs(diff) > 1e-12) return diff;
      return a.chunk_id.localeCompare(b.chunk_id);
    })
    .slice(0, topK)
    .map(({ rrf, vectorScore, textScore, matchSources, ...rest }) => {
      const result: FusionResult = rest;
      if (includeExplain) {
        result._explain = {
          rrf_score: rrf,
          match_sources: matchSources,
          ...(vectorScore !== undefined ? { vector_score: vectorScore } : {}),
          ...(textScore !== undefined ? { text_score: textScore } : {}),
        };
      }
      return result;
    });
}

function normalizeTextKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function dedupeFusionResults(results: FusionResult[]): FusionResult[] {
  const seen = new Set<string>();
  const deduped: FusionResult[] = [];
  for (const res of results) {
    const key = normalizeTextKey(res.text);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(res);
  }
  return deduped;
}

type SearchOutcome = {
  results: FusionResult[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
  retrieval_trace?: Record<string, unknown>;
};

type ListOutcome = {
  results: {
    id: string;
    user_id: string;
    namespace: string;
    text: string;
    metadata: Record<string, unknown>;
    created_at: string;
    memory_type?: string | null;
    source_memory_id?: string | null;
    importance?: number;
    retrieval_count?: number;
  }[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
};

type ExportOutcome = { artifact_base64: string; bytes: number; sha256: string; archive: Uint8Array };

type ImportOutcome = { imported_memories: number; imported_chunks: number };

export function finalizeResults(
  fused: FusionResult[],
  page: number,
  page_size: number,
): { results: FusionResult[]; total: number; has_more: boolean } {
  const deduped = dedupeFusionResults(fused);
  const offset = (page - 1) * page_size;
  const paged = deduped.slice(offset, offset + page_size);
  const total = deduped.length;
  return { results: paged, total, has_more: offset + page_size < total };
}

async function performSearch(
  auth: AuthContext,
  payload: SearchPayload,
  env: Env,
  supabase: SupabaseClient,
): Promise<SearchOutcome> {
  const searchStart = Date.now();
  const params = normalizeSearchPayload(payload);
  const { user_id, query, namespace, top_k, page, page_size, explain, search_mode, min_score, filters, retrieval_profile } =
    params;

  const needsVector = search_mode === "hybrid" || search_mode === "vector";
  if (needsVector) {
    try {
      await checkGlobalCostGuard(supabase, env);
    } catch (e) {
      if (e instanceof AIBudgetExceededError) {
        throw createHttpError(503, "ai_budget_exceeded", "AI usage temporarily paused due to budget protection.");
      }
      throw e;
    }
  }

  const desired = Math.min(MAX_FUSE_RESULTS, Math.max(top_k, page * page_size));
  const matchCount = Math.min(SEARCH_MATCH_COUNT, desired * 3);

  const needsKeyword = search_mode === "hybrid" || search_mode === "keyword";

  const sharedArgs = {
    workspaceId: auth.workspaceId,
    userId: user_id,
    namespace,
    matchCount,
    metadata: filters.metadata,
    startTime: filters.start_time,
    endTime: filters.end_time,
    memoryTypes: filters.memory_types,
    filterMode: filters.filter_mode,
  };

  let vectorResults: MatchResult[] = [];
  let textResults: MatchResult[] = [];

  if (needsVector && needsKeyword) {
    const embedResult = await embedText([query], env);
    const embeddingVector = vectorToPgvectorString(embedResult.embeddings[0]);
    [vectorResults, textResults] = await Promise.all([
      callMatchVector(supabase, { ...sharedArgs, queryEmbedding: embeddingVector }),
      callMatchText(supabase, { ...sharedArgs, query }),
    ]);
  } else if (needsVector) {
    const embedResult = await embedText([query], env);
    const embeddingVector = vectorToPgvectorString(embedResult.embeddings[0]);
    vectorResults = await callMatchVector(supabase, { ...sharedArgs, queryEmbedding: embeddingVector });
  } else {
    textResults = await callMatchText(supabase, { ...sharedArgs, query });
  }

  /* Quota reserved by caller (search/context/eval) via reserveQuotaAndMaybeRespond before calling performSearch. */
  const fused = reciprocalRankFusion(
    vectorResults,
    textResults,
    Math.min(matchCount, MAX_FUSE_RESULTS),
    !!explain,
  );

  const scored = min_score != null
    ? fused.filter((r) => r.score >= min_score)
    : fused;

  const final = finalizeResults(scored, page, page_size);

  if (final.results.length > 0) {
    bumpChunkAccess(supabase, auth.workspaceId, final.results.map((r) => r.chunk_id));
    bumpMemoryRetrievalCounts(supabase, auth.workspaceId, final.results.map((r) => r.memory_id));
  }

  const searchLatency = Date.now() - searchStart;
  logger.info({
    event: "search_request",
    search_latency_ms: searchLatency,
    search_mode,
    result_count: final.total,
    page,
    page_size,
  });

  const retrieval_trace: Record<string, unknown> = {
    search_mode,
    retrieval_profile,
    effective_min_score: min_score ?? null,
    vector_candidates: vectorResults.length,
    text_candidates: textResults.length,
    fused_count: fused.length,
    after_min_score_count: scored.length,
    result_total: final.total,
    latency_ms: searchLatency,
  };

  return {
    results: final.results,
    total: final.total,
    page,
    page_size,
    has_more: final.has_more,
    retrieval_trace,
  };
}

export async function performListMemories(
  auth: AuthContext,
  params: MemoryListParams,
  supabase: SupabaseClient,
): Promise<ListOutcome> {
  const { page, page_size, namespace, user_id, memory_type, filters } = params;
  const offset = (page - 1) * page_size;

  const rpc = await supabase.rpc("list_memories_scoped", {
    p_workspace_id: auth.workspaceId,
    p_page: page,
    p_page_size: page_size,
    p_namespace: namespace ?? null,
    p_user_id: user_id ?? null,
    p_memory_type: memory_type ?? null,
    p_metadata: filters.metadata ?? null,
    p_start_time: filters.start_time ?? null,
    p_end_time: filters.end_time ?? null,
  });
  if (rpc.error) {
    throw createHttpError(500, "DB_ERROR", rpc.error.message ?? "Failed to list memories");
  }
  if (Array.isArray(rpc.data)) {
    const rawRows = rpc.data as Array<{
      id: string;
      workspace_id: string;
      user_id: string;
      namespace: string;
      text: string;
      metadata: Record<string, unknown>;
      created_at: string;
      memory_type?: string | null;
      source_memory_id?: string | null;
      total_count?: number | null;
    }>;
    assertRowsWorkspaceScoped(rawRows as unknown as Array<Record<string, unknown>>, auth.workspaceId, "performListMemories.rpc");
    const has_more = rawRows.length > page_size;
    const pageRows = (has_more ? rawRows.slice(0, page_size) : rawRows).map(({ workspace_id: _workspaceId, total_count: _totalCount, ...rest }) => rest);
    const firstTotal = rawRows.find((r) => typeof r.total_count === "number")?.total_count;
    const total = typeof firstTotal === "number"
      ? firstTotal
      : offset + pageRows.length + (has_more ? 1 : 0);
    return {
      results: pageRows,
      total,
      page,
      page_size,
      has_more,
    };
  }
  throw createHttpError(500, "DB_ERROR", "Scoped list RPC returned invalid payload");
}

async function getMemoryByIdScoped(
  supabase: SupabaseClient,
  workspaceId: string,
  memoryId: string,
): Promise<ListOutcome["results"][number] | null> {
  const rpc = await supabase.rpc("get_memory_scoped", {
    p_workspace_id: workspaceId,
    p_memory_id: memoryId,
  });
  if (rpc.error) {
    throw createHttpError(500, "DB_ERROR", rpc.error.message ?? "Failed to fetch memory");
  }
  if (rpc.data) {
    const rows = Array.isArray(rpc.data) ? rpc.data : [rpc.data];
    const first = rows[0] as (ListOutcome["results"][number] & { workspace_id?: string }) | undefined;
    if (!first) return null;
    if (typeof first.workspace_id === "string" && first.workspace_id !== workspaceId) {
      throw createHttpError(500, "TENANT_SCOPE_VIOLATION", "Workspace scope violation in getMemoryByIdScoped");
    }
    if (typeof first.workspace_id === "string") {
      const { workspace_id: _workspaceId, ...rest } = first;
      return rest;
    }
    return first;
  }
  return null;
}

export { parseApiKeyMeta, redact };

// Stub embeddings (deterministic) for dev
const STUB_EMBED_DIM = 1536;
function stubEmbedding(text: string): number[] {
  const seed = hashStringToInt(text);
  const rng = mulberry32(seed);
  const arr = new Array(STUB_EMBED_DIM);
  for (let i = 0; i < STUB_EMBED_DIM; i++) {
    arr[i] = rng() * 2 - 1; // [-1, 1)
  }
  return arr;
}

function hashStringToInt(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0) || 1;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Usage accounting
type UsageRow = {
  workspace_id: string;
  day: string;
  writes: number;
  reads: number;
  embeds: number;
  extraction_calls?: number;
  embed_tokens_used?: number;
  gen_input_tokens_used?: number;
  gen_output_tokens_used?: number;
  storage_bytes_used?: number;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getUsage(
  supabase: SupabaseClient,
  workspaceId: string,
  day: string,
): Promise<UsageRow> {
  try {
    const v3 = await supabase
      .from("usage_daily_v2")
      .select("workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens, gen_input_tokens, gen_output_tokens, storage_bytes")
      .eq("workspace_id", workspaceId)
      .eq("day", day)
      .maybeSingle();
    if (!v3.error && v3.data) {
      const row = v3.data as Record<string, unknown>;
      return {
        workspace_id: workspaceId,
        day,
        writes: Number(row.writes) ?? 0,
        reads: Number(row.reads) ?? 0,
        embeds: Number(row.embeds) ?? 0,
        extraction_calls: Number(row.extraction_calls) ?? 0,
        embed_tokens_used: Number(row.embed_tokens) ?? 0,
        gen_input_tokens_used: Number(row.gen_input_tokens) ?? 0,
        gen_output_tokens_used: Number(row.gen_output_tokens) ?? 0,
        storage_bytes_used: Number(row.storage_bytes) ?? 0,
      };
    }
  } catch {
    // Backward compatibility for stubs/tests without usage_daily_v2 table.
  }

  const { data, error } = await supabase
    .from("usage_daily")
    .select("workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens_used")
    .eq("workspace_id", workspaceId)
    .eq("day", day)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw createHttpError(500, "DB_ERROR", `Failed to fetch usage: ${error.message}`);
  }
  if (!data) {
    return {
      workspace_id: workspaceId,
      day,
      writes: 0,
      reads: 0,
      embeds: 0,
      extraction_calls: 0,
      embed_tokens_used: 0,
      gen_input_tokens_used: 0,
      gen_output_tokens_used: 0,
      storage_bytes_used: 0,
    };
  }

  const row = data as Record<string, unknown>;
  return {
    workspace_id: workspaceId,
    day,
    writes: Number(row.writes) ?? 0,
    reads: Number(row.reads) ?? 0,
    embeds: Number(row.embeds) ?? 0,
    extraction_calls: Number(row.extraction_calls) ?? 0,
    embed_tokens_used: Number(row.embed_tokens_used) ?? 0,
    gen_input_tokens_used: 0,
    gen_output_tokens_used: 0,
    storage_bytes_used: 0,
  };
}

async function bumpUsage(
  supabase: SupabaseClient,
  workspaceId: string,
  day: string,
  deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
): Promise<UsageRow> {
  const { data, error } = await supabase.rpc("bump_usage_rpc", {
    p_workspace_id: workspaceId,
    p_day: day,
    p_writes: deltas.writesDelta,
    p_reads: deltas.readsDelta,
    p_embeds: deltas.embedsDelta,
  });

  if (error || !data) {
    throw createHttpError(500, "DB_ERROR", `Failed to bump usage: ${error?.message}`);
  }

  return data as UsageRow;
}

/** Estimate embed tokens from text length: ceil(len/4). */
function estimateEmbedTokens(textLength: number): number {
  return Math.ceil(Math.max(0, textLength) / 4);
}

/** Result of atomic cap check + bump. On success usage was incremented; on exceeded nothing was changed. */
type BumpWithinCapResult =
  | { ok: true; usage: UsageRow }
  | { ok: false; limit: string; used: number; cap: number };

async function _recordUsageEventIfWithinCap(
  supabase: SupabaseClient,
  workspaceId: string,
  day: string,
  deltas: {
    writesDelta: number;
    readsDelta: number;
    embedsDelta: number;
    embedTokensDelta: number;
    extractionCallsDelta: number;
  },
  planLimits: PlanLimits,
  env: Env,
  meta?: { route?: string; requestId?: string },
): Promise<BumpWithinCapResult> {
  const caps = {
    writes: planLimits.writes_per_day,
    reads: planLimits.reads_per_day,
    embeds: Math.floor(planLimits.embed_tokens_per_day / 200),
    embed_tokens: planLimits.embed_tokens_per_day,
    extraction_calls: planLimits.extraction_calls_per_day,
    gen_tokens: Math.max(0, planLimits.included_gen_tokens ?? 0),
    storage_bytes: Math.floor(Math.max(0, planLimits.included_storage_gb ?? 0) * 1_000_000_000),
  };
  const estimatedCostInr = estimateRequestCostInr(
    {
      writesDelta: deltas.writesDelta,
      readsDelta: deltas.readsDelta,
      embedTokensDelta: deltas.embedTokensDelta,
      extractionCallsDelta: deltas.extractionCallsDelta,
    },
    env,
  );
  const internalCredits = computeInternalCredits({
    writes: deltas.writesDelta,
    reads: deltas.readsDelta,
    embed_tokens: deltas.embedTokensDelta,
    extraction_calls: deltas.extractionCallsDelta,
  });
  const idempotencyKey = `${meta?.route ?? "route"}:${meta?.requestId ?? crypto.randomUUID()}:${workspaceId}:${day}:${deltas.writesDelta}:${deltas.readsDelta}:${deltas.embedsDelta}:${deltas.embedTokensDelta}:${deltas.extractionCallsDelta}`;
  const { data, error } = await supabase.rpc("record_usage_event_if_within_cap", {
    p_workspace_id: workspaceId,
    p_day: day,
    p_idempotency_key: idempotencyKey,
    p_request_id: meta?.requestId ?? null,
    p_route: meta?.route ?? "unknown",
    p_actor_type: "api_key",
    p_actor_id: null,
    p_writes: deltas.writesDelta,
    p_reads: deltas.readsDelta,
    p_embeds: deltas.embedsDelta,
    p_embed_tokens: deltas.embedTokensDelta,
    p_extraction_calls: deltas.extractionCallsDelta,
    p_gen_input_tokens: 0,
    p_gen_output_tokens: 0,
    p_storage_bytes: 0,
    p_estimated_cost_inr: estimatedCostInr,
    p_billable: true,
    p_metadata: {
      internal_credits_model: COST_MODEL_VERSION,
      internal_credits_total: internalCredits.total,
      internal_credits: internalCredits.breakdown,
    },
    p_writes_cap: caps.writes,
    p_reads_cap: caps.reads,
    p_embeds_cap: caps.embeds,
    p_embed_tokens_cap: caps.embed_tokens,
    p_extraction_calls_cap: caps.extraction_calls,
    p_gen_tokens_cap: caps.gen_tokens,
    p_storage_bytes_cap: caps.storage_bytes,
  });
  if (error) {
    throw createHttpError(500, "DB_ERROR", `Failed to record usage event: ${error.message}`);
  }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const row = rows[0] as
    | {
      exceeded?: boolean;
      limit_name?: string;
      writes?: number;
      reads?: number;
      embeds?: number;
      extraction_calls?: number;
      embed_tokens_used?: number;
      gen_input_tokens_used?: number;
      gen_output_tokens_used?: number;
      storage_bytes_used?: number;
    }
    | undefined;
  if (!row) {
    throw createHttpError(500, "DB_ERROR", "record_usage_event_if_within_cap returned no row");
  }
  if (row.exceeded && row.limit_name) {
    const used =
      row.limit_name === "writes"
        ? (row.writes ?? 0)
        : row.limit_name === "reads"
          ? (row.reads ?? 0)
          : row.limit_name === "embeds"
            ? (row.embeds ?? 0)
            : row.limit_name === "embed_tokens"
              ? (row.embed_tokens_used ?? 0)
              : row.limit_name === "extraction_calls"
                ? (row.extraction_calls ?? 0)
                : row.limit_name === "gen_tokens"
                  ? ((row.gen_input_tokens_used ?? 0) + (row.gen_output_tokens_used ?? 0))
                  : row.limit_name === "storage_bytes"
                    ? (row.storage_bytes_used ?? 0)
                    : 0;
    const cap =
      row.limit_name === "writes"
        ? caps.writes
        : row.limit_name === "reads"
          ? caps.reads
          : row.limit_name === "embeds"
            ? caps.embeds
            : row.limit_name === "embed_tokens"
              ? caps.embed_tokens
              : row.limit_name === "extraction_calls"
                ? caps.extraction_calls
                : row.limit_name === "gen_tokens"
                  ? caps.gen_tokens
                  : row.limit_name === "storage_bytes"
                    ? caps.storage_bytes
                    : 0;
    return { ok: false, limit: row.limit_name, used, cap };
  }
  return {
    ok: true,
    usage: {
      workspace_id: workspaceId,
      day,
      writes: row.writes ?? 0,
      reads: row.reads ?? 0,
      embeds: row.embeds ?? 0,
      extraction_calls: row.extraction_calls ?? 0,
      embed_tokens_used: row.embed_tokens_used ?? 0,
      gen_input_tokens_used: row.gen_input_tokens_used ?? 0,
      gen_output_tokens_used: row.gen_output_tokens_used ?? 0,
      storage_bytes_used: row.storage_bytes_used ?? 0,
    },
  };
}

export async function deleteMemoryCascade(
  supabase: SupabaseClient,
  workspaceId: string,
  memoryId: string,
): Promise<boolean> {
  const rpc = await supabase.rpc("delete_memory_scoped", {
    p_workspace_id: workspaceId,
    p_memory_id: memoryId,
  });
  if (rpc.error) {
    throw createHttpError(500, "DB_ERROR", rpc.error.message ?? "Failed to delete memory");
  }
  if (Array.isArray(rpc.data) && rpc.data.length > 0) {
    const first = rpc.data[0] as { deleted?: boolean };
    return Boolean(first.deleted);
  }
  if (rpc.data && typeof rpc.data === "object") {
    const row = rpc.data as { deleted?: boolean };
    if (typeof row.deleted === "boolean") return row.deleted;
  }
  return false;
}

/** Full deps for memory handlers when called directly (e.g. from tests). Defined after all helpers. */
const defaultMemoryHandlerDeps: MemoryHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  chunkText: chunkTextWithProfile,
  embedText,
  todayUtc,
  vectorToPgvectorString,
  emitProductEvent,
  bumpUsage,
  effectivePlan,
  normalizeMemoryListParams,
  performListMemories,
  getMemoryByIdScoped,
  deleteMemoryCascade,
  checkCapsAndMaybeRespond,
  resolveQuotaForWorkspace,
  reserveQuotaAndMaybeRespond,
  markUsageReservationCommitted,
  markUsageReservationRefundPending,
  planLimitExceededResponse,
  estimateEmbedTokens,
};

const memoryHandlersDefault = createMemoryHandlers(defaultMemoryHandlerDeps, defaultMemoryHandlerDeps);

/** Full deps for search handler when called directly (e.g. from tests). */
const defaultSearchHandlerDeps: SearchHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  resolveQuotaForWorkspace,
  rateLimitWorkspace,
  reserveQuotaAndMaybeRespond,
  markUsageReservationCommitted,
  markUsageReservationRefundPending,
  todayUtc,
  estimateEmbedTokens,
  performSearch,
  emitProductEvent,
  effectivePlan,
};

const searchHandlersDefault = createSearchHandlers(defaultSearchHandlerDeps, defaultSearchHandlerDeps);
const contextHandlersDefault = createContextHandlers(defaultSearchHandlerDeps, defaultSearchHandlerDeps);
const contextExplainHandlersDefault = createContextExplainHandlers(defaultSearchHandlerDeps, defaultSearchHandlerDeps);
const defaultEvalHandlerDeps: EvalHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  resolveQuotaForWorkspace,
  rateLimitWorkspace,
  reserveQuotaAndMaybeRespond,
  markUsageReservationCommitted,
  markUsageReservationRefundPending,
  todayUtc,
  estimateEmbedTokens,
  performSearch,
};
const evalHandlersDefault = createEvalHandlers(defaultEvalHandlerDeps, defaultEvalHandlerDeps);

const defaultPruningHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  resolveQuotaForWorkspace,
  rateLimitWorkspace,
};
const pruningHandlersDefault = createPruningHandlers(defaultPruningHandlerDeps, defaultPruningHandlerDeps);
const explainHandlersDefault = createExplainHandlers(defaultSearchHandlerDeps, defaultSearchHandlerDeps);

/** Full deps for usage handler when called directly (e.g. from tests). */
const defaultUsageHandlerDeps: UsageHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  todayUtc,
  rateLimitWorkspace,
  getUsage,
  resolveQuotaForWorkspace,
};
const usageHandlersDefault = createUsageHandlers(defaultUsageHandlerDeps, defaultUsageHandlerDeps);

const defaultAuditLogHandlerDeps: AuditLogHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  resolveQuotaForWorkspace,
  rateLimitWorkspace,
};
const auditLogHandlersDefault = createAuditLogHandlers(defaultAuditLogHandlerDeps, defaultAuditLogHandlerDeps);

const defaultDashboardOverviewDeps = {
  jsonResponse: simpleJsonResponse,
  resolveQuotaForWorkspace,
  rateLimitWorkspace,
};
const dashboardOverviewHandlersDefault = createDashboardOverviewHandlers(
  defaultDashboardOverviewDeps,
  defaultDashboardOverviewDeps,
);

/** Full deps for billing handlers (PayU logic remains in index). */
const defaultBillingHandlerDeps: BillingHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  normalizePlanStatus,
  resolveQuotaForWorkspace,
  emitEventLog,
  redact,
  resolveBillingWebhooksEnabled,
  isPayUBillingConfigured,
  assertPayUEnvFor,
  shortHash,
  fetchPayUTransactionByTxnId,
  formatAmountStrict,
  normalizeCurrency,
  transitionPayUTransactionStatus: transitionPayUTransactionStatus as BillingHandlerDeps["transitionPayUTransactionStatus"],
  buildPayURequestHashInput,
  computeSha512Hex,
  normalizePayUBaseUrl,
  emitProductEvent,
  resolveEntitlementPlanCode,
  getAmountForPlan: resolvePayUAmountForPlan,
  getProductInfoForPlan: resolveProductInfoForPlan,
  defaultSuccessPath: DEFAULT_SUCCESS_PATH,
  defaultCancelPath: DEFAULT_CANCEL_PATH,
  defaultProductInfo: DEFAULT_PAYU_PRODUCT_INFO,
};
const billingHandlersDefault = createBillingHandlers(defaultBillingHandlerDeps, defaultBillingHandlerDeps);

/** Full deps for webhook handler (PayU logic remains in index). */
const defaultWebhookHandlerDeps: WebhookHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  resolveBillingWebhooksEnabled,
  assertPayUEnvFor,
  emitEventLog,
  parseWebhookPayload: parseWebhookPayload as WebhookHandlerDeps["parseWebhookPayload"],
  asNonEmptyString,
  isPayUWebhookSignatureValid: isPayUWebhookSignatureValid as WebhookHandlerDeps["isPayUWebhookSignatureValid"],
  resolvePayUEventId: resolvePayUEventId as WebhookHandlerDeps["resolvePayUEventId"],
  resolvePayUEventType: resolvePayUEventType as WebhookHandlerDeps["resolvePayUEventType"],
  resolvePayUEventCreated: resolvePayUEventCreated as WebhookHandlerDeps["resolvePayUEventCreated"],
  reconcilePayUWebhook: reconcilePayUWebhook as WebhookHandlerDeps["reconcilePayUWebhook"],
  redact,
  logger: logger as unknown as WebhookHandlerDeps["logger"],
  isApiError,
};
const webhookHandlersDefault = createWebhookHandlers(defaultWebhookHandlerDeps, defaultWebhookHandlerDeps);

/** Full deps for admin handlers (PayU/billing logic remains in index). */
const defaultAdminHandlerDeps: AdminHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  requireAdmin,
  rateLimit,
  emitEventLog,
  redact,
  getFounderPhase1Metrics,
  reconcilePayUWebhook: reconcilePayUWebhook as AdminHandlerDeps["reconcilePayUWebhook"],
  defaultWebhookReprocessLimit: DEFAULT_WEBHOOK_REPROCESS_LIMIT,
  asNonEmptyString,
  resolvePayUVerifyTimeoutMs,
  resolveBillingWebhooksEnabled,
  normalizeCurrency,
};
const adminHandlersDefault = createAdminHandlers(defaultAdminHandlerDeps, defaultAdminHandlerDeps);

const defaultImportHandlerDeps: ImportHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  resolveQuotaForWorkspace,
  rateLimitWorkspace,
  reserveQuotaAndMaybeRespond,
  markUsageReservationCommitted,
  markUsageReservationRefundPending,
  todayUtc,
  importArtifact: importArtifact as ImportHandlerDeps["importArtifact"],
  defaultMaxImportBytes: DEFAULT_MAX_IMPORT_BYTES,
};
const importHandlersDefault = createImportHandlers(defaultImportHandlerDeps, defaultImportHandlerDeps);

const defaultWorkspacesHandlerDeps: WorkspacesHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  requireAdmin,
  rateLimit,
  emitProductEvent,
};
const workspacesHandlersDefault = createWorkspacesHandlers(defaultWorkspacesHandlerDeps, defaultWorkspacesHandlerDeps);

const defaultApiKeysHandlerDeps: ApiKeysHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  requireAdmin,
  rateLimit,
  generateApiKey,
  getApiKeySalt,
  hashApiKey,
  emitProductEvent,
  setStubApiKeyIfPresent,
};
const apiKeysHandlersDefault = createApiKeysHandlers(defaultApiKeysHandlerDeps, defaultApiKeysHandlerDeps);

export const handleCreateMemory = memoryHandlersDefault.handleCreateMemory;
export const handleListMemories = memoryHandlersDefault.handleListMemories;
export const handleGetMemory = memoryHandlersDefault.handleGetMemory;
export const handleDeleteMemory = memoryHandlersDefault.handleDeleteMemory;
export const handleSearch = searchHandlersDefault.handleSearch;
export const handleListSearchHistory = searchHandlersDefault.handleListSearchHistory;
export const handleReplaySearch = searchHandlersDefault.handleReplaySearch;
export const handleContextFeedback = searchHandlersDefault.handleContextFeedback;
export const handlePruningMetrics = pruningHandlersDefault.handlePruningMetrics;
export const handleExplainAnswer = explainHandlersDefault.handleExplainAnswer;
export const handleCreateEvalSet = evalHandlersDefault.handleCreateEvalSet;
export const handleListEvalSets = evalHandlersDefault.handleListEvalSets;
export const handleDeleteEvalSet = evalHandlersDefault.handleDeleteEvalSet;
export const handleCreateEvalItem = evalHandlersDefault.handleCreateEvalItem;
export const handleListEvalItems = evalHandlersDefault.handleListEvalItems;
export const handleDeleteEvalItem = evalHandlersDefault.handleDeleteEvalItem;
export const handleRunEvalSet = evalHandlersDefault.handleRunEvalSet;
export const handleContext = contextHandlersDefault.handleContext;
export const handleContextExplain = contextExplainHandlersDefault.handleContextExplain;
export const handleUsageToday = usageHandlersDefault.handleUsageToday;
export const handleListAuditLog = auditLogHandlersDefault.handleListAuditLog;
export const handleDashboardOverviewStats = dashboardOverviewHandlersDefault.handleDashboardOverviewStats;
export const handleBillingStatus = billingHandlersDefault.handleBillingStatus;
export const handleBillingCheckout = billingHandlersDefault.handleBillingCheckout;
export const handleBillingPortal = billingHandlersDefault.handleBillingPortal;
export const handleBillingWebhook = webhookHandlersDefault.handleBillingWebhook;
export const handleReprocessDeferredWebhooks = adminHandlersDefault.handleReprocessDeferredWebhooks;
export const handleReconcileUsageRefunds = adminHandlersDefault.handleReconcileUsageRefunds;
export const handleAdminBillingHealth = adminHandlersDefault.handleAdminBillingHealth;
export const handleFounderPhase1Metrics = adminHandlersDefault.handleFounderPhase1Metrics;
export const handleCleanupExpiredSessions = adminHandlersDefault.handleCleanupExpiredSessions;
export const handleMemoryHygiene = adminHandlersDefault.handleMemoryHygiene;
export const handleMemoryRetention = adminHandlersDefault.handleMemoryRetention;
export const handleImport = importHandlersDefault.handleImport;
export const handleCreateWorkspace = workspacesHandlersDefault.handleCreateWorkspace;
export const handleCreateApiKey = apiKeysHandlersDefault.handleCreateApiKey;
export const handleListApiKeys = apiKeysHandlersDefault.handleListApiKeys;
export const handleRevokeApiKey = apiKeysHandlersDefault.handleRevokeApiKey;

// Rate limiting backed by KV (survives restarts)
export function safeKvTtl(ttlSec: number): number {
  const numeric = Number.isFinite(ttlSec) ? Number(ttlSec) : 0;
  if (numeric <= 0) return 60;
  return Math.max(60, Math.ceil(numeric));
}

export { performSearch };

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `mn_live_${hex}`;
}

function setStubApiKeyIfPresent(
  supabase: SupabaseClient,
  rawKey: string,
  workspaceId: string,
): void {
  const stubKeys = (supabase as unknown as { __rawApiKeys?: Map<string, { workspaceId: string }> }).__rawApiKeys;
  if (stubKeys) stubKeys.set(rawKey, { workspaceId });
}

// ---------- Export / Import ----------
export function makeExportResponse(
  outcome: ExportOutcome,
  wantsZip: boolean,
  auth: AuthContext,
  rateHeaders: Record<string, string>,
  baseHeaders: Record<string, string>,
): Response {
  if (wantsZip) {
    const date = new Date().toISOString().slice(0, 10);
    const buf = outcome.archive.buffer
      .slice(outcome.archive.byteOffset, outcome.archive.byteOffset + outcome.archive.byteLength) as ArrayBuffer;
    const headers = {
      ...rateHeaders,
      ...baseHeaders,
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="memorynode-export-${auth.workspaceId}-${date}.zip"`,
    };
    return new Response(buf as BodyInit, { status: 200, headers });
  }

  return new Response(
    JSON.stringify({ artifact_base64: outcome.artifact_base64, bytes: outcome.bytes, sha256: outcome.sha256 }),
    {
      status: 200,
      headers: { "content-type": "application/json", ...rateHeaders, ...baseHeaders },
    },
  );
}

function resolveBillingWebhooksEnabled(env: Env): boolean {
  const raw = (env.BILLING_WEBHOOKS_ENABLED ?? "1").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return true;
}

export { buildPayURequestHashInput, buildPayUResponseReverseHashInput, computeSha512Hex } from "./billing/payuHash.js";
export type { PayURequestHashFields } from "./billing/payuHash.js";
export { normalizeSearchPayload, normalizeMemoryListParams } from "./search/normalizeRequest.js";
export type { NormalizedSearchParams, MetadataFilter } from "./search/normalizeRequest.js";
