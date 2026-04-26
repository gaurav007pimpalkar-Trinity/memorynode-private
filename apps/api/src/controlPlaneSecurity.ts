/**
 * Control-plane ingress gate: gated routes require `x-internal-secret` matching
 * `CONTROL_PLANE_SECRET` (no exceptions). Browser traffic uses the public API `/v1/admin/*` proxy.
 * Health probes are excluded.
 */

import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Env } from "./env.js";
import { resolveRequestId } from "./cors.js";

/** Routes that require `x-internal-secret` (no bypass). Browser hits public `/v1/admin/*` proxy only. */
export function controlPlanePathRequiresInternalSecret(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  if (pathname === "/v1/billing/webhook") return m === "POST";
  if (pathname.startsWith("/admin/")) return true;
  if (pathname.startsWith("/v1/admin/")) return true;
  return false;
}

function timingSafeEqualUtf8(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * @returns `Response` when the request must be rejected; `null` when allowed to proceed.
 */
export function assertControlPlaneGate(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  if (!controlPlanePathRequiresInternalSecret(pathname, request.method)) {
    return null;
  }

  const expected = (env.CONTROL_PLANE_SECRET ?? "").trim();
  const requestId = resolveRequestId(request);
  const jsonHeaders: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": requestId,
  };

  if (!expected) {
    return new Response(
      JSON.stringify({
        error: {
          code: "CONFIG_ERROR",
          message: "CONTROL_PLANE_SECRET must be set for control-plane routes",
        },
        request_id: requestId,
      }),
      { status: 503, headers: jsonHeaders },
    );
  }

  const presented = (request.headers.get("x-internal-secret") ?? "").trim();
  if (!presented) {
    return new Response(
      JSON.stringify({
        error: { code: "UNAUTHORIZED", message: "Missing x-internal-secret" },
        request_id: requestId,
      }),
      { status: 401, headers: jsonHeaders },
    );
  }

  if (!timingSafeEqualUtf8(presented, expected)) {
    return new Response(
      JSON.stringify({
        error: { code: "PERMISSION_DENIED", message: "Invalid x-internal-secret" },
        request_id: requestId,
      }),
      { status: 403, headers: jsonHeaders },
    );
  }

  return null;
}
