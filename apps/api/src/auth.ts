/**
 * API key auth, admin token, and rate limiting. Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { getEnvironmentStage, isRateLimitBindingPresent, type Env } from "./env.js";
import { createHttpError } from "./http.js";
import { withSupabaseQueryRetry } from "./supabaseRetry.js";
import { logger, redact } from "./logger.js";
import { generateRequestId } from "./cors.js";
import { getRateLimitMax } from "./limits.js";
import { createRequestScopedSupabaseClient } from "./dbClientFactory.js";

export interface AuthContext {
  workspaceId: string;
  keyHash: string;
  apiKeyId?: string;
  plan: "pro" | "team";
  planStatus?: "trialing" | "active" | "past_due" | "canceled";
  /** Set when authenticated via API key; used for new-key rate limit (15 RPM for first 48h). */
  keyCreatedAt?: string | null;
}

const ALLOWED_PLAN_STATUS = new Set(["trialing", "active", "past_due", "canceled"]);
const ADMIN_SIGNED_TTL_MS = 5 * 60 * 1000;
const ADMIN_REPLAY_TTL_MS = 10 * 60 * 1000;
const usedAdminNonces = new Map<string, number>();

type StubRow = Record<string, unknown>;

function bindScopedClient(target: SupabaseClient, scoped: SupabaseClient): void {
  const mutable = target as unknown as {
    from?: SupabaseClient["from"];
    rpc?: SupabaseClient["rpc"];
    __scoped_client_bound?: boolean;
  };
  mutable.from = scoped.from.bind(scoped);
  mutable.rpc = scoped.rpc.bind(scoped);
  mutable.__scoped_client_bound = true;
}

function shouldBindScopedClient(env: Env): boolean {
  return Boolean(env.SUPABASE_ANON_KEY && env.SUPABASE_JWT_SECRET);
}

function hasRpcClient(supabase: SupabaseClient): supabase is SupabaseClient & { rpc: SupabaseClient["rpc"] } {
  return typeof (supabase as unknown as { rpc?: unknown }).rpc === "function";
}

function isAuthMissError(err: unknown): boolean {
  const code = typeof (err as { code?: unknown } | null)?.code === "string"
    ? (err as { code: string }).code
    : "";
  const message = typeof (err as { message?: unknown } | null)?.message === "string"
    ? (err as { message: string }).message.toLowerCase()
    : "";
  return code === "PGRST116" || message.includes("no rows");
}

export function normalizePlanStatus(status: unknown): AuthContext["planStatus"] {
  if (typeof status === "string" && ALLOWED_PLAN_STATUS.has(status)) {
    return status as AuthContext["planStatus"];
  }
  if (status !== undefined) {
    logger.error({
      event: "invalid_plan_status",
      plan_status: redact(status, "plan_status"),
    });
  }
  return "past_due";
}

export function extractApiKey(request: Request): string | null {
  const headerKey = request.headers.get("x-api-key");
  if (headerKey) return headerKey.trim();

  const auth = request.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }

  return null;
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashApiKey(rawKey: string, salt: string): Promise<string> {
  return sha256Hex(salt + rawKey);
}

const SALT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedSalt: string | null = null;
let cachedSaltAt = 0;

function isSaltCacheValid(): boolean {
  return cachedSalt !== null && Date.now() - cachedSaltAt < SALT_CACHE_TTL_MS;
}

export async function getApiKeySalt(
  env: Env,
  supabase: SupabaseClient,
): Promise<{ salt: string; mismatchFatal: boolean }> {
  const envSalt = env.API_KEY_SALT || "";
  if (isSaltCacheValid() && !envSalt) {
    return { salt: cachedSalt!, mismatchFatal: false };
  }

  let data: unknown = null;
  let error: unknown = null;
  if (hasRpcClient(supabase)) {
    const rpcResult = await withSupabaseQueryRetry(async () => supabase.rpc("get_api_key_salt"));
    data = rpcResult.data;
    error = rpcResult.error;
  } else {
    error = { message: "rpc unavailable" };
  }
  let dbSalt = typeof data === "string" ? data : "";
  if ((error && env.SUPABASE_URL === "stub") || (!error && typeof data !== "string")) {
    const fallback = await withSupabaseQueryRetry(async () =>
      supabase.from("app_settings").select("api_key_salt").limit(1).single(),
    );
    dbSalt = (fallback.data as { api_key_salt?: string } | null)?.api_key_salt ?? "";
  }
  if (error && !envSalt && cachedSalt !== null) {
    return { salt: cachedSalt, mismatchFatal: false };
  }

  if (envSalt && dbSalt && envSalt !== dbSalt) {
    const requestId = generateRequestId();
    logger.error({
      event: "api_key_salt_mismatch",
      request_id: requestId,
      env_present: Boolean(envSalt),
      db_present: Boolean(dbSalt),
      env_length: envSalt.length,
      db_length: dbSalt.length,
    });
    return { salt: envSalt, mismatchFatal: true };
  }

  const saltToUse = envSalt || dbSalt || cachedSalt || "";
  cachedSalt = saltToUse;
  cachedSaltAt = Date.now();
  return { salt: saltToUse, mismatchFatal: false };
}

export async function authenticate(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  auditCtx?: { workspaceId?: string; apiKeyId?: string },
): Promise<AuthContext> {
  const { getDashboardSession, validateDashboardCsrf } = await import("./dashboardSession.js");
  const { parseAllowedOrigins } = await import("./cors.js");
  const dashSession = await getDashboardSession(request, supabase);
  if (dashSession) {
    const method = (request.method ?? "GET").toUpperCase();
    if (["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
      try {
        validateDashboardCsrf(request, dashSession, parseAllowedOrigins(env.ALLOWED_ORIGINS));
      } catch (e) {
        const msg = (e as Error).message;
        throw createHttpError(
          403,
          "PERMISSION_DENIED",
          msg === "CSRF_TOKEN_INVALID" || msg === "CSRF_TOKEN_REQUIRED"
            ? "Invalid or missing CSRF token"
            : "Origin not allowed",
        );
      }
    }
    const { data: ws } = await withSupabaseQueryRetry(async () => {
      if (shouldBindScopedClient(env)) {
        const scoped = await createRequestScopedSupabaseClient(env, {
          workspaceId: dashSession.workspaceId,
          keyHash: `dashboard:${dashSession.sessionId}`,
          apiKeyId: undefined,
          plan: "pro",
          planStatus: "past_due",
        });
        return scoped
          .from("workspaces")
          .select("plan, plan_status")
          .eq("id", dashSession.workspaceId)
          .maybeSingle();
      }
      return supabase
        .from("workspaces")
        .select("plan, plan_status")
        .eq("id", dashSession.workspaceId)
        .maybeSingle();
    });
    const planRaw = (ws as { plan?: string } | null)?.plan;
    const planStatusRaw = normalizePlanStatus((ws as { plan_status?: AuthContext["planStatus"] } | null)?.plan_status);
    const plan: AuthContext["plan"] = planRaw === "team" ? "team" : "pro";
    const ctx: AuthContext = {
      workspaceId: dashSession.workspaceId,
      keyHash: `dashboard:${dashSession.sessionId}`,
      plan,
      planStatus: planStatusRaw ?? "past_due",
    };
    if (shouldBindScopedClient(env)) {
      bindScopedClient(supabase, await createRequestScopedSupabaseClient(env, ctx));
    }
    if (auditCtx) {
      auditCtx.workspaceId = ctx.workspaceId;
      auditCtx.apiKeyId = undefined;
    }
    return ctx;
  }

  const rawKey = extractApiKey(request);
  if (!rawKey) {
    throw createHttpError(401, "UNAUTHORIZED", "Missing API key or session");
  }

  const stubKeys = (supabase as unknown as { __rawApiKeys?: Map<string, { workspaceId: string }>; __db?: Record<string, StubRow[]> }).__rawApiKeys;
  if (env.SUPABASE_URL === "stub" && stubKeys && stubKeys.has(rawKey)) {
    const workspaceId = stubKeys.get(rawKey)!.workspaceId;
    const db = (supabase as unknown as { __db?: Record<string, StubRow[]> }).__db;
    const wsRow = db?.workspaces?.find?.((w: StubRow) => w.id === workspaceId);
    const planRaw = (wsRow?.plan as string) ?? "pro";
    const planStatus = normalizePlanStatus(wsRow?.plan_status ?? "active") ?? "active";
    return { workspaceId, keyHash: rawKey, plan: planRaw === "team" ? "team" : "pro", planStatus };
  }

  const saltOutcome = await getApiKeySalt(env, supabase);
  if (saltOutcome.mismatchFatal) {
    throw createHttpError(500, "CONFIG_ERROR", "API key salt mismatch between env and database");
  }
  const hashed = await hashApiKey(rawKey, saltOutcome.salt);
  let data: unknown = null;
  let error: unknown = null;
  let authLookupError: unknown = null;
  if (hasRpcClient(supabase)) {
    const rpcResult = await withSupabaseQueryRetry(async () =>
      supabase.rpc("authenticate_api_key", { p_key_hash: hashed }),
    );
    data = rpcResult.data;
    error = rpcResult.error;
    authLookupError = rpcResult.error && !isAuthMissError(rpcResult.error) ? rpcResult.error : null;
  } else {
    error = { message: "rpc unavailable" };
    authLookupError = error;
  }
  let apiKeyRow = Array.isArray(data) ? data[0] : (data as Record<string, unknown> | null);
  let authMatched = !error && Boolean(apiKeyRow?.workspace_id);
  if (error || !authMatched) {
    const fallback = await withSupabaseQueryRetry(async () =>
      supabase
        .from("api_keys")
        .select("id, workspace_id, created_at, workspaces(plan, plan_status)")
        .eq("key_hash", hashed)
        .is("revoked_at", null)
        .single(),
    );
    data = fallback.data;
    error = fallback.error;
    if (fallback.error && !isAuthMissError(fallback.error)) {
      authLookupError = fallback.error;
    }
    apiKeyRow = Array.isArray(data) ? data[0] : (data as Record<string, unknown> | null);
    authMatched = !error && Boolean(apiKeyRow?.workspace_id);
  }
  const authDebugEnabled =
    (env.AUTH_DEBUG ?? "").trim() === "1" &&
    (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toLowerCase() === "dev";
  if (authDebugEnabled) {
    const errorCode = typeof (error as { code?: unknown } | null)?.code === "string"
      ? (error as { code: string }).code
      : undefined;
    const authLookupErrorCode = typeof (authLookupError as { code?: unknown } | null)?.code === "string"
      ? (authLookupError as { code: string }).code
      : undefined;
    console.info("auth_debug_verify", {
      matched: authMatched,
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(authLookupErrorCode ? { auth_lookup_error_code: authLookupErrorCode } : {}),
    });
  }

  if (!authMatched || !data) {
    if (authLookupError) {
      throw createHttpError(500, "DB_ERROR", "Authentication backend unavailable");
    }
    throw createHttpError(401, "UNAUTHORIZED", "Invalid API key");
  }

  const keyId = (apiKeyRow as { api_key_id?: string; id?: string } | null)?.api_key_id
    ?? (apiKeyRow as { id?: string } | null)?.id;
  const clientIp =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  try {
    if (keyId && hasRpcClient(supabase)) {
      void supabase
        .rpc("touch_api_key_usage", {
          p_key_id: keyId,
          p_last_used_ip: clientIp,
        })
        .then(() => {});
    }
  } catch {
    /* best-effort; stub Supabase may not implement .update */
  }

  const nestedWorkspace = (apiKeyRow as { workspaces?: { plan?: string; plan_status?: AuthContext["planStatus"] } } | null)?.workspaces;
  const workspace = apiKeyRow as { plan?: string; plan_status?: AuthContext["planStatus"] } | null;
  const planRaw = workspace?.plan ?? nestedWorkspace?.plan;
  const planStatusRaw = normalizePlanStatus(workspace?.plan_status ?? nestedWorkspace?.plan_status);
  const plan: AuthContext["plan"] = planRaw === "team" ? "team" : "pro";

  const createdAt = (apiKeyRow as { key_created_at?: string; created_at?: string } | null)?.key_created_at
    ?? (apiKeyRow as { created_at?: string } | null)?.created_at
    ?? null;
  const ctx: AuthContext = {
    workspaceId: (apiKeyRow?.workspace_id as string | undefined) ?? "",
    keyHash: hashed,
    apiKeyId: keyId,
    plan,
    planStatus: planStatusRaw ?? "past_due",
    keyCreatedAt: createdAt,
  };
  if (shouldBindScopedClient(env)) {
    bindScopedClient(supabase, await createRequestScopedSupabaseClient(env, ctx));
  }
  if (auditCtx) {
    auditCtx.workspaceId = ctx.workspaceId;
    auditCtx.apiKeyId = keyId;
  }
  return ctx;
}

export async function rateLimit(
  key: string,
  env: Env,
  auth?: Pick<AuthContext, "keyCreatedAt">,
  explicitLimit?: number,
): Promise<{ allowed: boolean; headers: Record<string, string> }> {
  if ((env.RATE_LIMIT_MODE ?? "on").toLowerCase() === "off") return { allowed: true, headers: {} };
  if (!isRateLimitBindingPresent(env)) {
    const stage = getEnvironmentStage(env);
    if (stage === "staging" || stage === "prod") {
      logger.error({
        event: "rate_limit_binding_missing",
        request_id: generateRequestId(),
        stage,
      });
      throw createHttpError(
        503,
        "RATE_LIMIT_UNAVAILABLE",
        "Rate limit service unavailable: RATE_LIMIT_DO binding missing in this environment",
      );
    }
    return { allowed: true, headers: {} };
  }
  const ns = env.RATE_LIMIT_DO;
  const max = explicitLimit && Number.isFinite(explicitLimit) && explicitLimit > 0
    ? Math.floor(explicitLimit)
    : getRateLimitMax(env, auth?.keyCreatedAt);
  const name = `rl:${key}`;
  const id = ns.idFromName(name);
  const stub = ns.get(id);
  let resp: Response;
  try {
    resp = await stub.fetch("https://rate-limit/check", {
      method: "POST",
      body: JSON.stringify({ limit: max }),
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    logger.error({
      event: "rate_limit_do_unavailable",
      request_id: generateRequestId(),
      message: redact((err as Error)?.message, "message"),
    });
    throw createHttpError(503, "RATE_LIMIT_UNAVAILABLE", "Rate limit service unavailable");
  }
  if (!resp.ok) {
    logger.error({
      event: "rate_limit_do_unavailable",
      request_id: generateRequestId(),
      status: resp.status,
    });
    throw createHttpError(503, "RATE_LIMIT_UNAVAILABLE", "Rate limit service unavailable");
  }
  const data = (await resp.json()) as { allowed: boolean; count: number; limit: number; reset: number };
  const nowSec = Math.floor(Date.now() / 1000);
  const retryAfter = Math.max(0, data.reset - nowSec);
  const headers = {
    "x-ratelimit-limit": data.limit.toString(),
    "x-ratelimit-remaining": Math.max(0, data.limit - data.count).toString(),
    "x-ratelimit-reset": data.reset.toString(),
    "retry-after": retryAfter.toString(),
  };
  return { allowed: data.allowed, headers };
}

/** Workspace-level rate limit (Plan v2). Call after key rate limit. Uses same DO with rl-ws:workspaceId. */
export async function rateLimitWorkspace(
  workspaceId: string,
  workspaceRpm: number,
  env: Env,
): Promise<{ allowed: boolean; headers: Record<string, string> }> {
  if ((env.RATE_LIMIT_MODE ?? "on").toLowerCase() === "off") return { allowed: true, headers: {} };
  if (!isRateLimitBindingPresent(env)) {
    const stage = getEnvironmentStage(env);
    if (stage === "staging" || stage === "prod") {
      throw createHttpError(
        503,
        "RATE_LIMIT_UNAVAILABLE",
        "Rate limit service unavailable: RATE_LIMIT_DO binding missing in this environment",
      );
    }
    return { allowed: true, headers: {} };
  }
  const ns = env.RATE_LIMIT_DO;
  const name = `rl-ws:${workspaceId}`;
  const id = ns.idFromName(name);
  const stub = ns.get(id);
  let resp: Response;
  try {
    resp = await stub.fetch("https://rate-limit/check", {
      method: "POST",
      body: JSON.stringify({ limit: Math.max(1, Math.floor(workspaceRpm)) }),
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    throw createHttpError(503, "RATE_LIMIT_UNAVAILABLE", "Rate limit service unavailable");
  }
  if (!resp.ok) {
    throw createHttpError(503, "RATE_LIMIT_UNAVAILABLE", "Rate limit service unavailable");
  }
  const data = (await resp.json()) as { allowed: boolean; count: number; limit: number; reset: number };
  const nowSec = Math.floor(Date.now() / 1000);
  const retryAfter = Math.max(0, data.reset - nowSec);
  const headers = {
    "x-ratelimit-workspace-limit": data.limit.toString(),
    "x-ratelimit-workspace-remaining": Math.max(0, data.limit - data.count).toString(),
    "x-ratelimit-workspace-reset": data.reset.toString(),
    "retry-after": retryAfter.toString(),
  };
  return { allowed: data.allowed, headers };
}

const WORKSPACE_CONCURRENCY_MAX_DEFAULT = 8;
const WORKSPACE_CONCURRENCY_TTL_MS_DEFAULT = 30_000;

function resolveWorkspaceConcurrencyMax(env: Env): number {
  const parsed = Number(env.WORKSPACE_CONCURRENCY_MAX ?? WORKSPACE_CONCURRENCY_MAX_DEFAULT);
  if (!Number.isFinite(parsed) || parsed <= 0) return WORKSPACE_CONCURRENCY_MAX_DEFAULT;
  return Math.max(1, Math.floor(parsed));
}

function resolveWorkspaceConcurrencyTtlMs(env: Env): number {
  const parsed = Number(env.WORKSPACE_CONCURRENCY_TTL_MS ?? WORKSPACE_CONCURRENCY_TTL_MS_DEFAULT);
  if (!Number.isFinite(parsed) || parsed <= 0) return WORKSPACE_CONCURRENCY_TTL_MS_DEFAULT;
  return Math.max(1_000, Math.min(120_000, Math.floor(parsed)));
}

export async function acquireWorkspaceConcurrencySlot(
  workspaceId: string,
  env: Env,
): Promise<{ allowed: boolean; leaseToken: string | null; headers: Record<string, string> }> {
  if ((env.RATE_LIMIT_MODE ?? "on").toLowerCase() === "off") {
    return { allowed: true, leaseToken: null, headers: {} };
  }
  if (!isRateLimitBindingPresent(env)) {
    const stage = getEnvironmentStage(env);
    if (stage === "staging" || stage === "prod") {
      throw createHttpError(
        503,
        "RATE_LIMIT_UNAVAILABLE",
        "Concurrency limiter unavailable: RATE_LIMIT_DO binding missing in this environment",
      );
    }
    return { allowed: true, leaseToken: null, headers: {} };
  }
  const ns = env.RATE_LIMIT_DO;
  const name = `conc-ws:${workspaceId}`;
  const id = ns.idFromName(name);
  const stub = ns.get(id);
  let resp: Response;
  try {
    resp = await stub.fetch("https://rate-limit/concurrency", {
      method: "POST",
      body: JSON.stringify({
        action: "concurrency_acquire",
        limit: resolveWorkspaceConcurrencyMax(env),
        ttl_ms: resolveWorkspaceConcurrencyTtlMs(env),
      }),
      headers: { "content-type": "application/json" },
    });
  } catch {
    throw createHttpError(503, "RATE_LIMIT_UNAVAILABLE", "Concurrency limiter unavailable");
  }
  if (!resp.ok) {
    throw createHttpError(503, "RATE_LIMIT_UNAVAILABLE", "Concurrency limiter unavailable");
  }
  const data = (await resp.json()) as {
    allowed: boolean;
    count: number;
    limit: number;
    token?: string;
    retry_after?: number;
  };
  const retryAfter = Math.max(0, Number(data.retry_after ?? 1));
  const headers = {
    "x-workspace-inflight-limit": String(Math.max(0, Number(data.limit ?? 0))),
    "x-workspace-inflight-count": String(Math.max(0, Number(data.count ?? 0))),
    "retry-after": String(retryAfter),
  };
  return {
    allowed: data.allowed === true,
    leaseToken: data.allowed === true && typeof data.token === "string" && data.token.length > 0
      ? data.token
      : null,
    headers,
  };
}

export async function releaseWorkspaceConcurrencySlot(
  workspaceId: string,
  leaseToken: string | null | undefined,
  env: Env,
): Promise<void> {
  if (!leaseToken || leaseToken.trim().length === 0) return;
  if ((env.RATE_LIMIT_MODE ?? "on").toLowerCase() === "off") return;
  if (!isRateLimitBindingPresent(env)) return;
  const ns = env.RATE_LIMIT_DO;
  const name = `conc-ws:${workspaceId}`;
  const id = ns.idFromName(name);
  const stub = ns.get(id);
  try {
    await stub.fetch("https://rate-limit/concurrency", {
      method: "POST",
      body: JSON.stringify({
        action: "concurrency_release",
        token: leaseToken,
      }),
      headers: { "content-type": "application/json" },
    });
  } catch {
    /* best effort */
  }
}

/**
 * When `ADMIN_ALLOWED_IPS` is set, reject admin token auth unless the client IP matches (exact).
 * Uses `cf-connecting-ip` or first `x-forwarded-for`. `*` in the list disables IP restriction.
 */
export function assertAdminRequestIpAllowed(request: Request, env: Env): void {
  const raw = env.ADMIN_ALLOWED_IPS?.trim();
  if (!raw) return;
  const allow = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return;
  if (allow.includes("*")) return;
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  if (ip === "unknown") {
    throw createHttpError(403, "FORBIDDEN", "Admin access denied");
  }
  if (!allow.includes(ip)) {
    throw createHttpError(403, "FORBIDDEN", "Admin access denied");
  }
}

function resolveAdminAuthMode(env: Env): "legacy" | "signed-required" {
  const explicit = (env.ADMIN_AUTH_MODE ?? "").trim().toLowerCase();
  if (explicit === "legacy") return "legacy";
  if (explicit === "signed-required") return "signed-required";
  const stage = getEnvironmentStage(env);
  return stage === "prod" || stage === "staging" ? "signed-required" : "legacy";
}

function isBreakGlassEnabled(env: Env): boolean {
  return (env.ADMIN_BREAK_GLASS ?? "").trim() === "1";
}

function pruneUsedAdminNonces(nowMs: number): void {
  for (const [nonce, expiresAt] of usedAdminNonces.entries()) {
    if (expiresAt <= nowMs) usedAdminNonces.delete(nonce);
  }
}

async function verifySignedAdminRequest(request: Request, env: Env): Promise<void> {
  const tsRaw = request.headers.get("x-admin-timestamp")?.trim() ?? "";
  const nonce = request.headers.get("x-admin-nonce")?.trim() ?? "";
  const signature = request.headers.get("x-admin-signature")?.trim() ?? "";
  if (!tsRaw || !nonce || !signature) {
    throw createHttpError(401, "UNAUTHORIZED", "Missing signed admin headers");
  }
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) {
    throw createHttpError(401, "UNAUTHORIZED", "Invalid admin timestamp");
  }
  const now = Date.now();
  if (Math.abs(now - ts) > ADMIN_SIGNED_TTL_MS) {
    throw createHttpError(401, "UNAUTHORIZED", "Expired admin signature");
  }
  pruneUsedAdminNonces(now);
  if (usedAdminNonces.has(nonce)) {
    throw createHttpError(401, "UNAUTHORIZED", "Admin signature replay detected");
  }
  if (nonce.length < 12) {
    throw createHttpError(401, "UNAUTHORIZED", "Invalid admin nonce");
  }
  const url = new URL(request.url);
  const method = (request.method ?? "GET").toUpperCase();
  const base = `${method}\n${url.pathname}\n${tsRaw}\n${nonce}`;
  const expectedSig = createHmac("sha256", env.MASTER_ADMIN_TOKEN ?? "").update(base).digest("hex");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  const providedBuf = Buffer.from(signature, "utf8");
  const valid =
    providedBuf.length === expectedBuf.length &&
    timingSafeEqual(providedBuf, expectedBuf);
  if (!valid) {
    throw createHttpError(401, "UNAUTHORIZED", "Invalid admin signature");
  }
  usedAdminNonces.set(nonce, now + ADMIN_REPLAY_TTL_MS);
}

export async function requireAdmin(request: Request, env: Env): Promise<{ token: string }> {
  assertAdminRequestIpAllowed(request, env);
  const token = request.headers.get("x-admin-token");
  const expected = env.MASTER_ADMIN_TOKEN ?? "";
  const mode = resolveAdminAuthMode(env);
  if (mode === "signed-required") {
    const provided = token ?? "";
    const providedBuf = Buffer.from(provided, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    const legacyValid =
      providedBuf.length === expectedBuf.length &&
      timingSafeEqual(providedBuf, expectedBuf);
    if (legacyValid && isBreakGlassEnabled(env)) {
      logger.error({
        event: "admin_break_glass_auth_used",
        request_id: generateRequestId(),
      });
      return { token: provided };
    }
    await verifySignedAdminRequest(request, env);
    return { token: "<signed>" };
  }

  const provided = token ?? "";
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  const valid =
    providedBuf.length === expectedBuf.length &&
    timingSafeEqual(providedBuf, expectedBuf);
  if (!valid) {
    throw createHttpError(401, "UNAUTHORIZED", "Invalid admin token");
  }
  return { token: provided };
}
