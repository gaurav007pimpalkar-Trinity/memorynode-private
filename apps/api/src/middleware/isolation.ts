import type { Env } from "../env.js";
import { getEnvironmentStage } from "../env.js";
import { resolveIsolation, type IsolationInput, type ResolvedIsolation } from "../isolation/isolation.js";

export interface IsolationMiddlewareResult {
  isolation: ResolvedIsolation;
  responseHeaders: Record<string, string>;
}

function shouldEmitDebugHeaders(request: Request, env: Env): boolean {
  if (request.headers.get("x-mn-debug-routing") === "1") return true;
  const stage = getEnvironmentStage(env);
  return stage !== "prod";
}

/**
 * Single enforcement point for routing isolation resolution.
 * Call this once per request path and pass the returned `isolation` downstream.
 */
export function enforceIsolation(
  request: Request,
  env: Env,
  input: IsolationInput,
  options?: { scopedContainerTag?: string | null },
): IsolationMiddlewareResult {
  const isolation = resolveIsolation(input, options);
  const responseHeaders: Record<string, string> = {};

  if (isolation.fallbackUsed) {
    responseHeaders["x-mn-routing-fallback"] = "true";
  }
  if (isolation.scopeOverridden) {
    responseHeaders["x-mn-scope-override"] = "true";
  }
  if (shouldEmitDebugHeaders(request, env)) {
    responseHeaders["x-mn-resolved-container-tag"] = isolation.containerTag;
    responseHeaders["x-mn-routing-mode"] = isolation.routingMode;
  }

  return { isolation, responseHeaders };
}

