/**
 * Dashboard API client. Phase 0.2: auth via session cookie only (credentials: 'include').
 * CSRF token required for mutating calls (Phase 0).
 */

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Set callback for 401/403 (no stale workspace: clear session and workspace selection). */
export function setOnUnauthorized(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

const apiBaseFromEnv = import.meta.env.VITE_API_BASE_URL as string | undefined;
const isProd = import.meta.env.PROD;
const isLocalhost = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url ?? "");
const allowedBase = apiBaseFromEnv?.trim();
const noFallbackInProd = isProd && (!allowedBase || isLocalhost(allowedBase));
const API_BASE_URL = noFallbackInProd ? "" : (allowedBase ?? "http://127.0.0.1:8787");
export const apiEnvError = !allowedBase
  ? "Missing VITE_API_BASE_URL"
  : noFallbackInProd
    ? "Production build requires a non-localhost VITE_API_BASE_URL"
    : null;

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

type ApiError = { error: { code: string; message: string } };

export class ApiClientError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** User-facing message for common API errors (Phase 4.3). */
export function userFacingErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    const code = (err.code ?? "").toUpperCase();
    if (err.code === "METHOD_NOT_ALLOWED")
      return "That action isn't allowed. Try a different request.";
    if (code === "RATE_LIMITED" || code === "RATE_LIMIT_UNAVAILABLE")
      return "Too many requests right now. Please wait a moment and try again.";
    if (code === "PAYLOAD_TOO_LARGE") return "Request too large. Try a smaller payload.";
    if (code === "CONFIG" || code === "CONFIG_ERROR")
      return "App configuration is incomplete. Contact support or check env settings.";
    if (code === "CORS_DENY") return "This app URL is not allowed by API CORS settings.";
    if (err.status === 401) return "Session expired or invalid. Please sign in again.";
    if (err.status === 403) return "You don't have permission for this action.";
    if (err.status === 404) return "Not found.";
    if (code === "DAILY_CAP_EXCEEDED") return "Daily fair-use cap exceeded. Try again tomorrow.";
    if (code === "MONTHLY_CAP_EXCEEDED") return "Monthly cap exceeded. Upgrade to continue.";
    if (err.status === 402) return "Usage cap exceeded. Upgrade or try again later.";
    if (err.status >= 500) return "Something went wrong. Please try again.";
    return err.message || `Request failed (${err.status})`;
  }
  if (err instanceof TypeError) {
    return "Unable to reach the server. Check your connection and API URL, then retry.";
  }
  return err instanceof Error ? err.message : String(err);
}

async function fetchJson<T>(
  path: string,
  init: RequestInit,
  opts?: { suppressUnauthorizedHandling?: boolean },
): Promise<T> {
  if (!API_BASE_URL) {
    throw new ApiClientError(0, "CONFIG", apiEnvError ?? "VITE_API_BASE_URL is not configured.");
  }
  const res = await fetch(new URL(path, API_BASE_URL).toString(), {
    ...init,
    credentials: "include",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    if (!opts?.suppressUnauthorizedHandling && (res.status === 401 || res.status === 403)) {
      setCsrfToken(null);
      onUnauthorized?.();
    }
    const err = (json as ApiError | null)?.error;
    throw new ApiClientError(res.status, err?.code, err?.message ?? `Request failed: ${res.status}`);
  }
  return (json as T) ?? ({} as T);
}

/** Create or refresh dashboard session. Call after Supabase auth when workspace is selected. Sets CSRF token for mutating calls. */
export async function ensureDashboardSession(accessToken: string, workspaceId: string): Promise<void> {
  if (!API_BASE_URL) {
    throw new ApiClientError(0, "CONFIG", apiEnvError ?? "VITE_API_BASE_URL is not configured.");
  }
  const res = await fetch(new URL("/v1/dashboard/session", API_BASE_URL).toString(), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_token: accessToken, workspace_id: workspaceId }),
  });
  if (!res.ok) {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }
    const err = (json as ApiError | null)?.error;
    throw new ApiClientError(res.status, err?.code, err?.message ?? `Session failed: ${res.status}`);
  }
  const data = (await res.json()) as { csrf_token?: string };
  setCsrfToken(data.csrf_token ?? null);
}

export async function dashboardLogout(): Promise<void> {
  if (!API_BASE_URL) return;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  await fetch(new URL("/v1/dashboard/logout", API_BASE_URL).toString(), {
    method: "POST",
    credentials: "include",
    headers,
  });
  setCsrfToken(null);
}

export async function apiPost<T>(path: string, body: unknown = {}, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  return fetchJson<T>(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function apiGet<T>(path: string): Promise<T> {
  return fetchJson<T>(path, { method: "GET" });
}

export async function apiDelete<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  return fetchJson<T>(path, { method: "DELETE", headers });
}

export async function apiPatch<T>(path: string, body: unknown = {}, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  return fetchJson<T>(path, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

export async function adminGet<T>(path: string, adminToken: string): Promise<T> {
  return fetchJson<T>(
    path,
    {
      method: "GET",
      headers: { "x-admin-token": adminToken },
    },
    { suppressUnauthorizedHandling: true },
  );
}
