/**
 * API key auth, admin token, and rate limiting. Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";
import { createHttpError } from "./http.js";
import { withSupabaseQueryRetry } from "./supabaseRetry.js";
import { logger, redact } from "./logger.js";
import { generateRequestId } from "./cors.js";
import { getRateLimitMax } from "./limits.js";

export interface AuthContext {
  workspaceId: string;
  keyHash: string;
  plan: "free" | "pro" | "team";
  planStatus?: "free" | "trialing" | "active" | "past_due" | "canceled";
  /** Set when authenticated via API key; used for new-key rate limit (15 RPM for first 48h). */
  keyCreatedAt?: string | null;
}

const ALLOWED_PLAN_STATUS = new Set(["free", "trialing", "active", "past_due", "canceled"]);

type StubRow = Record<string, unknown>;

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
  return "free";
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

let cachedSalt: string | null = null;

export async function getApiKeySalt(
  env: Env,
  supabase: SupabaseClient,
): Promise<{ salt: string; mismatchFatal: boolean }> {
  const envSalt = env.API_KEY_SALT || "";
  const { data, error } = await withSupabaseQueryRetry(async () =>
    supabase.from("app_settings").select("api_key_salt").limit(1).single(),
  );
  const dbSalt = (data as { api_key_salt?: string } | null)?.api_key_salt ?? "";
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
    const { data: ws } = await withSupabaseQueryRetry(async () =>
      supabase
        .from("workspaces")
        .select("plan, plan_status")
        .eq("id", dashSession.workspaceId)
        .maybeSingle(),
    );
    const planRaw = (ws as { plan?: string } | null)?.plan;
    const planStatusRaw = normalizePlanStatus((ws as { plan_status?: AuthContext["planStatus"] } | null)?.plan_status);
    const plan: AuthContext["plan"] = planRaw === "pro" || planRaw === "team" ? planRaw : "free";
    const ctx: AuthContext = {
      workspaceId: dashSession.workspaceId,
      keyHash: `dashboard:${dashSession.sessionId}`,
      plan,
      planStatus: planStatusRaw ?? "free",
    };
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
    const planRaw = (wsRow?.plan as string) ?? "free";
    const planStatus = normalizePlanStatus(wsRow?.plan_status ?? "active") ?? "active";
    return { workspaceId, keyHash: rawKey, plan: planRaw === "team" ? "team" : planRaw === "pro" ? "pro" : "free", planStatus };
  }

  const saltOutcome = await getApiKeySalt(env, supabase);
  if (saltOutcome.mismatchFatal) {
    throw createHttpError(500, "CONFIG_ERROR", "API key salt mismatch between env and database");
  }
  const hashed = await hashApiKey(rawKey, saltOutcome.salt);
  const { data, error } = await withSupabaseQueryRetry(async () =>
    supabase
      .from("api_keys")
      .select("id, workspace_id, created_at, workspaces(plan, plan_status)")
      .eq("key_hash", hashed)
      .is("revoked_at", null)
      .single(),
  );
  const authMatched = !error && Boolean(data?.workspace_id);
  if ((env.AUTH_DEBUG ?? "").trim() === "1") {
    const errorCode = typeof (error as { code?: unknown } | null)?.code === "string"
      ? (error as { code: string }).code
      : undefined;
    console.info("auth_debug_verify", {
      hash_prefix: hashed.slice(0, 12),
      matched: authMatched,
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  }

  if (!authMatched || !data) {
    throw createHttpError(401, "UNAUTHORIZED", "Invalid API key");
  }

  const keyId = (data as { id?: string }).id;
  const clientIp =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  try {
    void supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString(), last_used_ip: clientIp })
      .eq("id", keyId)
      .then(() => {});
  } catch {
    /* best-effort; stub Supabase may not implement .update */
  }

  const workspace = (data as unknown as { workspaces?: { plan?: string; plan_status?: AuthContext["planStatus"] } })
    .workspaces;
  const planRaw = workspace?.plan;
  const planStatusRaw = normalizePlanStatus(workspace?.plan_status);
  const plan: AuthContext["plan"] = planRaw === "pro" || planRaw === "team" ? planRaw : "free";

  const createdAt = (data as { created_at?: string })?.created_at ?? null;
  const ctx: AuthContext = {
    workspaceId: data.workspace_id as string,
    keyHash: hashed,
    plan,
    planStatus: planStatusRaw ?? "free",
    keyCreatedAt: createdAt,
  };
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
): Promise<{ allowed: boolean; headers: Record<string, string> }> {
  if ((env.RATE_LIMIT_MODE ?? "on").toLowerCase() === "off") return { allowed: true, headers: {} };
  const ns = env.RATE_LIMIT_DO;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    return { allowed: true, headers: {} };
  }
  const max = getRateLimitMax(env, auth?.keyCreatedAt);
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
    throw createHttpError(503, "RATE_LIMIT_UNAVAILABLE", "Rate limit service unavailable");
  }
  if (!resp.ok) {
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

export async function requireAdmin(request: Request, env: Env): Promise<{ token: string }> {
  const token = request.headers.get("x-admin-token");
  if (!token || token !== env.MASTER_ADMIN_TOKEN) {
    throw createHttpError(401, "UNAUTHORIZED", "Invalid admin token");
  }
  return { token };
}
