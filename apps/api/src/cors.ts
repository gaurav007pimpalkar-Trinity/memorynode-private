/**
 * Per-request CORS, security headers, and request-id state. Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 *
 * Uses AsyncLocalStorage to scope per-request state to the current async context,
 * preventing header cross-contamination between concurrent requests in the same isolate.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface RequestScopedHeaders {
  corsHeaders: Record<string, string>;
  securityHeaders: Record<string, string>;
  requestId: string;
}

const requestStore = new AsyncLocalStorage<RequestScopedHeaders>();

const EMPTY_STORE: Readonly<RequestScopedHeaders> = Object.freeze({
  corsHeaders: {},
  securityHeaders: {},
  requestId: "",
});

function getStore(): RequestScopedHeaders {
  return requestStore.getStore() ?? (EMPTY_STORE as RequestScopedHeaders);
}

/**
 * Run a function inside a request-scoped async context.
 * All set/get/clear operations on CORS, security, and request-id headers
 * are isolated to this context and cannot leak to concurrent requests.
 */
export function runInRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  return requestStore.run(
    { corsHeaders: {}, securityHeaders: {}, requestId: "" },
    fn,
  );
}

export function setCorsHeadersForRequest(headers: Record<string, string>): void {
  const store = requestStore.getStore();
  if (store) store.corsHeaders = headers;
}

export function clearCorsHeadersForRequest(): void {
  const store = requestStore.getStore();
  if (store) store.corsHeaders = {};
}

export function getCorsHeaders(): Record<string, string> {
  return getStore().corsHeaders;
}

export function setSecurityHeadersForRequest(path: string): void {
  const store = requestStore.getStore();
  if (store) store.securityHeaders = buildSecurityHeaders(path);
}

export function clearSecurityHeadersForRequest(): void {
  const store = requestStore.getStore();
  if (store) store.securityHeaders = {};
}

export function getSecurityHeaders(): Record<string, string> {
  return getStore().securityHeaders;
}

export function setRequestIdForRequest(requestId: string): void {
  const store = requestStore.getStore();
  if (store) store.requestId = requestId;
}

export function clearRequestIdForRequest(): void {
  const store = requestStore.getStore();
  if (store) store.requestId = "";
}

export function getRequestIdHeaderValue(): string {
  return getStore().requestId;
}

export function getRequestIdHeaders(): Record<string, string> {
  const id = getStore().requestId;
  return id ? { "x-request-id": id } : {};
}

export function buildSecurityHeaders(path: string): Record<string, string> {
  const base: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
  };
  const sensitive =
    path.startsWith("/v1/api-keys") ||
    path.startsWith("/v1/workspaces") ||
    path.startsWith("/v1/usage") ||
    path.startsWith("/v1/dashboard/") ||
    path.startsWith("/v1/import");

  base["cache-control"] = sensitive ? "no-store" : "private, no-cache, must-revalidate";
  return base;
}

export function parseAllowedOrigins(raw?: string): string[] | null {
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

export function isOriginAllowed(origin: string, allowlist: string[] | null): boolean {
  if (!allowlist) return true;
  // Non-browser clients usually omit Origin; allow those requests.
  if (!origin) return true;
  if (allowlist.includes("*")) return true;
  return allowlist.some((allowed) => allowed === origin);
}

export function makeCorsHeaders(
  origin: string,
  allowlist: string[] | null,
  requestHeaders?: Headers,
): Record<string, string> {
  if (!allowlist) return {};
  const requestedHeaders = requestHeaders?.get("access-control-request-headers");
  const base = {
    vary: "Origin",
    "access-control-allow-headers": requestedHeaders ?? "authorization,content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS,DELETE",
    "access-control-max-age": "600",
  };
  if (allowlist.includes("*")) {
    return { ...base, "access-control-allow-origin": "*" };
  }
  if (allowlist.includes(origin)) {
    return { ...base, "access-control-allow-origin": origin };
  }
  return {};
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Request-scoped context built by the caller (e.g. workerApp) and passed to buildResponseHeaders.
 * Compatibility type for code that constructs ctx without using AsyncLocalStorage.
 */
export interface RequestContext {
  requestId: string;
  corsHeaders: Record<string, string>;
  securityHeaders: Record<string, string>;
}

/**
 * Merges CORS, security, and x-request-id from a RequestContext into a single headers object.
 * Does not use AsyncLocalStorage; caller passes the context explicitly.
 */
export function buildResponseHeaders(ctx: RequestContext): Record<string, string> {
  return {
    ...ctx.corsHeaders,
    ...ctx.securityHeaders,
    "x-request-id": ctx.requestId,
  };
}

export function generateRequestId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

export function resolveRequestId(request: Request): string {
  const incoming = (request.headers.get("x-request-id") ?? "").trim();
  if (incoming && REQUEST_ID_RE.test(incoming)) {
    return incoming;
  }
  return generateRequestId();
}
