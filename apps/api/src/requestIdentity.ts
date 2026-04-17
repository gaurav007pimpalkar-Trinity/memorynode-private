import { createHttpError } from "./http.js";
import type { Env } from "./env.js";

export interface WorkspaceRequestIdentity {
  workspaceId: string;
  subject: string;
  scope: string;
}

function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signHs256(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const bytes = new Uint8Array(sig);
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Mint a short-lived workspace-scoped JWT for request-path DB access.
 * The token is intentionally narrow (workspace_id + scope + short exp).
 */
export async function mintWorkspaceScopedJwt(
  env: Env,
  identity: WorkspaceRequestIdentity,
  ttlSeconds = 60,
): Promise<string> {
  const secret = env.SUPABASE_JWT_SECRET?.trim();
  if (!secret) {
    throw createHttpError(500, "CONFIG_ERROR", "SUPABASE_JWT_SECRET is required for scoped DB access");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      aud: "authenticated",
      role: "authenticated",
      sub: identity.subject,
      workspace_id: identity.workspaceId,
      scope: identity.scope,
      iat: now,
      exp: now + Math.max(10, ttlSeconds),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await signHs256(signingInput, secret);
  return `${signingInput}.${signature}`;
}
