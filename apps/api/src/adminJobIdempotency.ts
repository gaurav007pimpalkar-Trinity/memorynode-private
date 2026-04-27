import { createHash } from "node:crypto";
import type { Env } from "./env.js";
import { rateLimit } from "./auth.js";

/** Stable fingerprint for admin auth (never log raw token). */
export function buildAdminAuthFingerprint(request: Request, token: string): string {
  const h = createHash("sha256");
  if (token && token !== "<signed>") {
    h.update(token);
  } else {
    h.update(request.headers.get("x-admin-nonce") ?? "");
    h.update("|");
    h.update(request.headers.get("x-admin-signature") ?? "");
  }
  return h.digest("hex").slice(0, 32);
}

/**
 * When `Idempotency-Key` / `x-idempotency-key` is present (4+ chars), enforce at most one logical
 * execution per rolling window (same DO bucket as rate limits: 60s by default).
 */
export async function checkAdminJobIdempotency(
  env: Env,
  routeKey: string,
  request: Request,
  token: string,
): Promise<{ duplicate: boolean }> {
  const raw =
    request.headers.get("Idempotency-Key")?.trim() ??
    request.headers.get("x-idempotency-key")?.trim() ??
    "";
  if (raw.length < 4) return { duplicate: false };
  const fp = buildAdminAuthFingerprint(request, token);
  const composite = `${routeKey}:${fp}:${raw}`;
  const r = await rateLimit(`idem-admin:${composite}`, env, undefined, 1);
  return { duplicate: !r.allowed };
}
