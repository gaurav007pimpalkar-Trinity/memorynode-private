/**
 * Dashboard session: opaque id in httpOnly cookie. Phase 0.2 BEST_IN_MARKET_PLAN.
 * Session store is DB (dashboard_sessions). No long-lived keys in browser.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";

export const DASHBOARD_SESSION_COOKIE = "mn_dash_session";
export const SESSION_TTL_SEC = 15 * 60; // 15 min

export interface DashboardSession {
  userId: string;
  workspaceId: string;
  sessionId: string;
  csrfToken: string | null;
}

function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";").map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

export function getDashboardSessionIdFromCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  return parseCookie(cookie, DASHBOARD_SESSION_COOKIE);
}

export async function getDashboardSession(
  request: Request,
  supabase: SupabaseClient,
): Promise<DashboardSession | null> {
  const sessionId = getDashboardSessionIdFromCookie(request);
  if (!sessionId) return null;
  const { data, error } = await supabase
    .from("dashboard_sessions")
    .select("id, user_id, workspace_id, expires_at, csrf_token")
    .eq("id", sessionId)
    .maybeSingle();
  if (error || !data) return null;
  const expiresAt = (data as { expires_at?: string }).expires_at;
  if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) return null;
  return {
    sessionId: (data as { id: string }).id,
    userId: (data as { user_id: string }).user_id,
    workspaceId: (data as { workspace_id: string }).workspace_id,
    csrfToken: (data as { csrf_token?: string | null }).csrf_token ?? null,
  };
}

function randomCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createDashboardSession(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  ttlSec: number = SESSION_TTL_SEC,
): Promise<{ sessionId: string; csrfToken: string }> {
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  const csrfToken = randomCsrfToken();
  const { data, error } = await supabase
    .from("dashboard_sessions")
    .insert({ user_id: userId, workspace_id: workspaceId, expires_at: expiresAt, csrf_token: csrfToken })
    .select("id")
    .single();
  if (error || !data) throw new Error("Failed to create dashboard session");
  return { sessionId: (data as { id: string }).id, csrfToken };
}

export async function deleteDashboardSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<void> {
  await supabase.from("dashboard_sessions").delete().eq("id", sessionId);
}

const AUTH_VERIFY_MAX_RETRIES = 2;
const AUTH_VERIFY_RETRY_DELAYS_MS = [500, 1000];

/** Verify Supabase user JWT and return user id. Uses Auth API Get User. Retries on 5xx/429 or network error. */
export async function verifySupabaseAccessToken(
  accessToken: string,
  env: Env,
): Promise<{ userId: string } | null> {
  const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  if (env.SUPABASE_ANON_KEY) {
    headers.apikey = env.SUPABASE_ANON_KEY;
  }
  for (let attempt = 0; attempt <= AUTH_VERIFY_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method: "GET", headers });
      const retryable = res.status === 429 || res.status >= 500;
      if (res.ok) {
        const data = (await res.json()) as { id?: string };
        const userId = data?.id;
        return userId ? { userId } : null;
      }
      if (!retryable) return null;
    } catch {
      /* network error; retry */
    }
    if (attempt < AUTH_VERIFY_MAX_RETRIES) {
      const delayMs = AUTH_VERIFY_RETRY_DELAYS_MS[attempt] ?? 1000;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

export function sessionCookieHeader(sessionId: string, maxAgeSec: number, secure = true): string {
  const parts = [
    `${DASHBOARD_SESSION_COOKIE}=${sessionId}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(secure = true): string {
  const parts = [
    `${DASHBOARD_SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export const CSRF_HEADER = "x-csrf-token";

/**
 * Validate CSRF and Origin for mutating dashboard requests. Throws if invalid.
 * SameSite=Lax + Origin/Referer validation + CSRF token (BEST_IN_MARKET_PLAN 0.2 Add A).
 */
export function validateDashboardCsrf(
  request: Request,
  session: DashboardSession,
  originAllowlist: string[] | null,
): void {
  if (!session.csrfToken) {
    throw new Error("CSRF_TOKEN_REQUIRED");
  }
  const token = request.headers.get(CSRF_HEADER)?.trim();
  if (token !== session.csrfToken) {
    throw new Error("CSRF_TOKEN_INVALID");
  }
  const origin = request.headers.get("origin")?.trim();
  if (origin) {
    if (!originAllowlist || originAllowlist.length === 0) {
      throw new Error("ORIGIN_NOT_ALLOWED");
    }
    const allowed = originAllowlist.includes(origin) || originAllowlist.includes("*");
    if (!allowed) {
      throw new Error("ORIGIN_NOT_ALLOWED");
    }
  }
}
