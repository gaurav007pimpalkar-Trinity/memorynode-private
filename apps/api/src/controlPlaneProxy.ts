/**
 * Public API → control-plane forward for `/v1/admin/*`.
 * Injects `x-internal-secret` and `x-memorynode-proxy-client-ip` (from public ingress only; not
 * client-controlled on the trusted forward path).
 *
 * Circuit breaker: shared `CIRCUIT_BREAKER_DO` circuit `control_plane_proxy` tracks recent
 * failures (timeouts / network errors / upstream HTTP 5xx). When open, returns 503 immediately
 * without calling upstream (half-open after cooldown per DO state machine).
 *
 * Structured logs (JSON line to stdout via `logger`):
 * - `control_plane_metric_proxy` — counter-style metrics (latency, outcome).
 * - Success: `control_plane_admin_proxy_result` …
 * - Retriable error: `control_plane_admin_proxy_error` …
 * - Final failure → 502: `control_plane_admin_proxy_failed` …
 *
 * Control-plane Worker logs `control_plane_request` and billing metrics in `workerApp.ts`.
 */

import type { CircuitName } from "./circuitBreakerDO.js";
import {
  circuitBreakerDOIsOpen,
  circuitBreakerDORecordFailure,
  circuitBreakerDORecordSuccess,
} from "./circuitBreakerDO.js";
import { isOpen, recordFailure as memRecordFailure, recordSuccess as memRecordSuccess } from "./circuitBreaker.js";
import type { Env } from "./env.js";
import { logControlPlaneProxyMetric, type ControlPlaneProxyMetricOutcome } from "./controlPlaneMetrics.js";
import { logger, redact } from "./logger.js";

const CONTROL_PLANE_FETCH_TIMEOUT_MS = 8_000;
const CP_PROXY_CIRCUIT: CircuitName = "control_plane_proxy";

function clientIpFromPublicIngress(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ""
  );
}

export function resolveControlPlaneUpstreamTargetUrl(request: Request, upstreamOrigin: string): string {
  const u = new URL(request.url);
  const base = upstreamOrigin.replace(/\/$/, "");
  return `${base}${u.pathname}${u.search}`;
}

/** Headers copied from the browser→public request plus server-set internal auth and client IP. */
export function buildControlPlaneProxyHeaders(request: Request, internalSecret: string): Headers {
  const headers = new Headers();
  headers.set("x-internal-secret", internalSecret);

  const passThrough = [
    "x-admin-token",
    "x-admin-timestamp",
    "x-admin-nonce",
    "x-admin-signature",
    "content-type",
    "accept",
    "x-request-id",
  ] as const;
  for (const name of passThrough) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }

  const clientIp = clientIpFromPublicIngress(request);
  if (clientIp) {
    headers.set("x-memorynode-proxy-client-ip", clientIp);
  }

  return headers;
}

function createTimeoutSignal(ms: number): AbortSignal {
  const Ab = AbortSignal as typeof AbortSignal & { timeout?: (n: number) => AbortSignal };
  if (typeof Ab.timeout === "function") {
    return Ab.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function isRetriableProxyFailure(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  if (/network|fetch failed|Failed to fetch|ECONNRESET|ETIMEDOUT/i.test(msg)) return true;
  return false;
}

function proxyFailureReason(err: unknown): "timeout" | "network" | "unknown" {
  if (err instanceof DOMException && err.name === "AbortError") return "timeout";
  if (err instanceof TypeError) return "network";
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(msg)) return "timeout";
  if (/network|fetch failed|Failed to fetch/i.test(msg)) return "network";
  return "unknown";
}

async function fetchControlPlaneOnce(targetUrl: string, init: RequestInit): Promise<Response> {
  const signal = createTimeoutSignal(CONTROL_PLANE_FETCH_TIMEOUT_MS);
  return fetch(targetUrl, { ...init, signal, redirect: "manual" });
}

function json502(requestId: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: { code: "BAD_GATEWAY", message },
      request_id: requestId,
    }),
    {
      status: 502,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
    },
  );
}

function json503Circuit(requestId: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message:
          "Control-plane proxy circuit is open after repeated upstream failures or timeouts. Try again after a short cooldown.",
      },
      request_id: requestId,
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
    },
  );
}

async function cpProxyCircuitIsOpen(env?: Env): Promise<boolean> {
  const ns = env?.CIRCUIT_BREAKER_DO;
  if (ns && typeof ns.get === "function") {
    return circuitBreakerDOIsOpen(ns, CP_PROXY_CIRCUIT);
  }
  return isOpen(CP_PROXY_CIRCUIT);
}

async function cpProxyCircuitRecordSuccess(env?: Env): Promise<void> {
  const ns = env?.CIRCUIT_BREAKER_DO;
  if (ns && typeof ns.get === "function") {
    await circuitBreakerDORecordSuccess(ns, CP_PROXY_CIRCUIT);
  } else {
    memRecordSuccess(CP_PROXY_CIRCUIT);
  }
}

async function cpProxyCircuitRecordFailure(env?: Env): Promise<void> {
  const ns = env?.CIRCUIT_BREAKER_DO;
  if (ns && typeof ns.get === "function") {
    await circuitBreakerDORecordFailure(ns, CP_PROXY_CIRCUIT);
  } else {
    memRecordFailure(CP_PROXY_CIRCUIT);
  }
}

function metricOutcomeFromUpstreamStatus(status: number): ControlPlaneProxyMetricOutcome {
  if (status >= 500) return "upstream_5xx";
  if (status >= 400) return "upstream_4xx";
  return "ok";
}

export type ForwardAdminOptions = {
  requestId: string;
  /** When `CIRCUIT_BREAKER_DO` is bound, circuit state is shared across isolates. */
  env?: Env;
};

export async function forwardAdminRequestToControlPlane(
  request: Request,
  upstreamOrigin: string,
  internalSecret: string,
  opts: ForwardAdminOptions,
): Promise<Response> {
  const { requestId, env } = opts;
  const pathname = new URL(request.url).pathname;
  const method = (request.method ?? "GET").toUpperCase();

  if (await cpProxyCircuitIsOpen(env)) {
    logControlPlaneProxyMetric({
      request_id: requestId,
      route: pathname,
      method: request.method,
      outcome: "circuit_open",
      latency_ms: 0,
      attempt: 0,
    });
    return json503Circuit(requestId);
  }

  const targetUrl = resolveControlPlaneUpstreamTargetUrl(request, upstreamOrigin);
  const headers = buildControlPlaneProxyHeaders(request, internalSecret);
  const initBase: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  const init: RequestInit =
    method === "GET" || method === "HEAD"
      ? initBase
      : ({
          ...initBase,
          body: request.body,
          duplex: "half",
        } as RequestInit);

  const started = Date.now();
  const attemptsMax = method === "GET" || method === "HEAD" ? 2 : 1;
  let lastErr: unknown;
  let lastAttempt = 0;

  for (let attempt = 1; attempt <= attemptsMax; attempt++) {
    lastAttempt = attempt;
    try {
      const res = await fetchControlPlaneOnce(targetUrl, init);
      const latencyMs = Date.now() - started;
      if (res.status >= 500) {
        await cpProxyCircuitRecordFailure(env);
        logControlPlaneProxyMetric({
          request_id: requestId,
          route: pathname,
          method: request.method,
          outcome: "upstream_5xx",
          latency_ms: latencyMs,
          attempt,
          upstream_status: res.status,
        });
      } else {
        await cpProxyCircuitRecordSuccess(env);
        logControlPlaneProxyMetric({
          request_id: requestId,
          route: pathname,
          method: request.method,
          outcome: metricOutcomeFromUpstreamStatus(res.status),
          latency_ms: latencyMs,
          attempt,
          upstream_status: res.status,
        });
      }
      logger.info({
        event: "control_plane_admin_proxy_result",
        request_id: requestId,
        route: pathname,
        method: request.method,
        outcome: "success",
        upstream_status: res.status,
        latency_ms: latencyMs,
        attempt,
      });
      return res;
    } catch (err) {
      lastErr = err;
      const reason = proxyFailureReason(err);
      const retriable = isRetriableProxyFailure(err);
      const latencyMs = Date.now() - started;
      logger.error({
        event: "control_plane_admin_proxy_error",
        request_id: requestId,
        route: pathname,
        method: request.method,
        outcome: retriable ? "retriable_failure" : "failure",
        failure_reason: reason,
        latency_ms: latencyMs,
        attempt,
        err,
      });
      if (attempt < attemptsMax && retriable && (method === "GET" || method === "HEAD")) {
        continue;
      }
      break;
    }
  }

  const latencyMs = Date.now() - started;
  const reason = proxyFailureReason(lastErr);
  await cpProxyCircuitRecordFailure(env);
  const terminalOutcome: ControlPlaneProxyMetricOutcome =
    reason === "timeout" ? "timeout" : reason === "network" ? "network" : "unknown";
  logControlPlaneProxyMetric({
    request_id: requestId,
    route: pathname,
    method: request.method,
    outcome: terminalOutcome,
    latency_ms: latencyMs,
    attempt: lastAttempt,
    failure_reason: reason,
  });
  logger.error({
    event: "control_plane_admin_proxy_failed",
    request_id: requestId,
    route: pathname,
    method: request.method,
    outcome: "failed",
    failure_reason: reason,
    latency_ms: latencyMs,
    message: redact(lastErr instanceof Error ? lastErr.message : String(lastErr), "message"),
    err: lastErr,
  });

  const human =
    reason === "timeout"
      ? "Control-plane request timed out after 8s"
      : reason === "network"
        ? "Could not reach control-plane (network error)"
        : "Control-plane proxy failed";
  return json502(requestId, human);
}
