/**
 * Per-request CORS, security headers, and request-id state. Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * Uses request-scoped RequestContext to avoid shared mutable state across concurrent requests.
 */

export interface RequestContext {
  requestId: string;
  corsHeaders: Record<string, string>;
  securityHeaders: Record<string, string>;
}

export function buildResponseHeaders(ctx: RequestContext): Record<string, string> {
  const headers: Record<string, string> = { ...ctx.corsHeaders, ...ctx.securityHeaders };
  if (ctx.requestId) headers["x-request-id"] = ctx.requestId;
  return headers;
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
    path.startsWith("/v1/import") ||
    path.startsWith("/v1/export");

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
  if (!origin) return false;
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
