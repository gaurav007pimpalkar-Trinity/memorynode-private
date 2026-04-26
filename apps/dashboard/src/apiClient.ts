import { API_PATHS } from "./config/apiPaths";
/**
 * Dashboard API client — browser calls against the Worker with `credentials: "include"`.
 *
 * **Why JWT/session (not API key in headers)?** After `ensureDashboardSession`, the Worker ties
 * requests to your Supabase user + selected workspace via HTTP-only cookies set by `/v1/dashboard/session`.
 * Mutating calls also send `x-csrf-token`. This is correct for an interactive console.
 *
 * **Parity with API key usage:** Route paths and JSON bodies are identical to `docs.memorynode.ai`.
 * Production apps send `Authorization: Bearer <API key>` instead of cookies; the Worker resolves the same
 * workspace + auth rules. Copy-as-curl snippets (`apiCurl.ts`) deliberately show `YOUR_API_KEY`, not cookies,
 * so engineers can replay the same JSON from servers or shells.
 *
 * **Success correlation:** HTTP responses include `x-request-id`; use `apiPostWithMeta` / `apiGetWithMeta`
 * when the UI should display that id next to curl blocks. Errors embed `request_id` in JSON when present.
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

/** Public API base for “Copy as curl” (same host the dashboard uses, or a safe default for display). */
export function getApiBaseUrl(): string {
  if (API_BASE_URL) return API_BASE_URL.replace(/\/$/, "");
  return "https://api.memorynode.ai";
}

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

type ApiErrorBody = {
  error?: { code?: string; message?: string; request_id?: string };
};

type ApiErrorPayload = ApiErrorBody & { upgrade_url?: string };
type DashboardEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error?: { code?: string; message?: string; details?: unknown } };

export class ApiClientError extends Error {
  status: number;
  code?: string;
  /** Server correlation id when present on error responses */
  requestId?: string;
  /** Present on some 402 responses (e.g. trial ended, caps) when the API returns `upgrade_url`. */
  upgradeUrl?: string;
  constructor(
    status: number,
    code: string | undefined,
    message: string,
    requestId?: string,
    upgradeUrl?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.upgradeUrl = upgradeUrl;
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
    if (code === "TRIAL_EXPIRED") {
      return err.upgradeUrl?.trim()
        ? `Your MemoryNode trial has ended. Continue with billing: ${err.upgradeUrl.trim()}`
        : "Your MemoryNode trial has ended. Open Billing to add a payment method and continue saving changes.";
    }
    if (err.status === 402) return "Usage cap exceeded. Upgrade or try again later.";
    if (err.status >= 500) {
      const base = "Something went wrong. Please try again.";
      if (err.requestId?.trim()) return `${base} Request ID: ${err.requestId.trim()}`;
      return base;
    }
    const base = err.message || `Request failed (${err.status})`;
    if (err.requestId?.trim()) return `${base} Request ID: ${err.requestId.trim()}`;
    return base;
  }
  if (err instanceof TypeError) {
    return "Unable to reach the server. Check your connection and API URL, then retry.";
  }
  return err instanceof Error ? err.message : String(err);
}

export type ApiJsonResult<T> = { data: T; requestId?: string };

async function fetchJsonAtBase<T>(
  baseUrl: string,
  path: string,
  init: RequestInit,
  opts?: { suppressUnauthorizedHandling?: boolean },
): Promise<ApiJsonResult<T>> {
  const res = await fetch(new URL(path, baseUrl).toString(), {
    ...init,
    credentials: "include",
  });
  const headerRequestId = res.headers.get("x-request-id")?.trim() || undefined;
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
    const body = json as ApiErrorPayload | null;
    const err = body?.error;
    const combinedRequestId =
      typeof err?.request_id === "string" && err.request_id.trim() ? err.request_id.trim() : headerRequestId;
    const upgradeUrl =
      typeof body?.upgrade_url === "string" && body.upgrade_url.trim() ? body.upgrade_url.trim() : undefined;
    throw new ApiClientError(
      res.status,
      err?.code,
      err?.message ?? `Request failed: ${res.status}`,
      combinedRequestId,
      upgradeUrl,
    );
  }
  const data = ((json as T) ?? ({} as T)) as T;
  return { data, requestId: headerRequestId };
}

async function fetchJson<T>(
  path: string,
  init: RequestInit,
  opts?: { suppressUnauthorizedHandling?: boolean },
): Promise<ApiJsonResult<T>> {
  if (!API_BASE_URL) {
    throw new ApiClientError(0, "CONFIG", apiEnvError ?? "VITE_API_BASE_URL is not configured.");
  }
  return fetchJsonAtBase<T>(API_BASE_URL, path, init, opts);
}

/** Create or refresh dashboard session. Call after Supabase auth when workspace is selected. Sets CSRF token for mutating calls. */
export async function ensureDashboardSession(accessToken: string, workspaceId: string): Promise<void> {
  if (!API_BASE_URL) {
    throw new ApiClientError(0, "CONFIG", apiEnvError ?? "VITE_API_BASE_URL is not configured.");
  }
  const res = await fetch(new URL(API_PATHS.dashboard.session, API_BASE_URL).toString(), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_token: accessToken, workspace_id: workspaceId }),
  });
  if (!res.ok) {
    const headerRid = res.headers.get("x-request-id")?.trim() || undefined;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }
    const payload = json as ApiErrorPayload | null;
    const err = payload?.error;
    const combinedRid = typeof err?.request_id === "string" && err.request_id.trim() ? err.request_id.trim() : headerRid;
    const upgradeUrl =
      typeof payload?.upgrade_url === "string" && payload.upgrade_url.trim()
        ? payload.upgrade_url.trim()
        : undefined;
    throw new ApiClientError(
      res.status,
      err?.code,
      err?.message ?? `Session failed: ${res.status}`,
      combinedRid,
      upgradeUrl,
    );
  }
  const data = (await res.json()) as { csrf_token?: string };
  setCsrfToken(data.csrf_token ?? null);
}

/** Same as `apiPost` plus `requestId` from response `x-request-id` when present (success paths). */
export async function apiPostWithMeta<T>(
  path: string,
  body: unknown = {},
  extraHeaders?: Record<string, string>,
): Promise<ApiJsonResult<T>> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  return fetchJson<T>(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Same as `apiGet` plus `requestId` from response `x-request-id` when present. */
export async function apiGetWithMeta<T>(path: string): Promise<ApiJsonResult<T>> {
  return fetchJson<T>(path, { method: "GET" });
}

export async function dashboardLogout(): Promise<void> {
  if (!API_BASE_URL) return;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  await fetch(new URL(API_PATHS.dashboard.logout, API_BASE_URL).toString(), {
    method: "POST",
    credentials: "include",
    headers,
  });
  setCsrfToken(null);
}

export async function apiPost<T>(path: string, body: unknown = {}, extraHeaders?: Record<string, string>): Promise<T> {
  const { data } = await apiPostWithMeta<T>(path, body, extraHeaders);
  return data;
}

export async function apiGet<T>(path: string): Promise<T> {
  const { data } = await apiGetWithMeta<T>(path);
  return data;
}

function unwrapDashboardEnvelope<T>(
  envelope: DashboardEnvelope<T>,
  statusFallback = 400,
): T {
  if (envelope && typeof envelope === "object" && "ok" in envelope && envelope.ok === true) {
    return envelope.data;
  }
  const code =
    envelope && typeof envelope === "object" && "error" in envelope
      ? envelope.error?.code
      : "DASHBOARD_API_ERROR";
  const message =
    envelope && typeof envelope === "object" && "error" in envelope
      ? envelope.error?.message ?? "Dashboard API request failed"
      : "Dashboard API request failed";
  throw new ApiClientError(statusFallback, code, message);
}

/** Dashboard endpoint helper for `{ ok, data, error }` envelopes. */
export async function dashboardApiGet<T>(path: string): Promise<T> {
  const { data } = await apiGetWithMeta<DashboardEnvelope<T>>(path);
  return unwrapDashboardEnvelope(data);
}

/** Dashboard endpoint helper for `{ ok, data, error }` envelopes. */
export async function dashboardApiPost<T>(
  path: string,
  body: unknown = {},
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const { data } = await apiPostWithMeta<DashboardEnvelope<T>>(path, body, extraHeaders);
  return unwrapDashboardEnvelope(data);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  const { data } = await fetchJson<T>(path, { method: "DELETE", headers });
  return data;
}

export async function apiPatch<T>(path: string, body: unknown = {}, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  const { data } = await fetchJson<T>(path, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  return data;
}

export async function adminGet<T>(path: string, adminToken: string): Promise<T> {
  const base = getApiBaseUrl();
  if (!base) {
    throw new ApiClientError(0, "CONFIG", apiEnvError ?? "VITE_API_BASE_URL is not configured.");
  }
  const { data } = await fetchJsonAtBase<T>(
    base,
    path,
    {
      method: "GET",
      headers: { "x-admin-token": adminToken },
    },
    { suppressUnauthorizedHandling: true },
  );
  return data;
}
