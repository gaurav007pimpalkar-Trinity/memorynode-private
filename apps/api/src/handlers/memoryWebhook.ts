/**
 * POST /v1/webhooks/memory — HMAC-signed JSON mapped to POST /v1/memories (billing webhooks stay separate).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import { rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import { MemoryWebhookIngestSchema } from "../contracts/index.js";

export interface MemoryWebhookHandlerDeps extends HandlerDeps {
  handleCreateMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
}

function normalizeSignatureHeader(raw: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  if (lower.startsWith("sha256=")) return s.slice(7).trim();
  return s;
}

export function createMemoryWebhookHandlers(defaultDeps: MemoryWebhookHandlerDeps): {
  handleMemoryWebhookIngest: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleMemoryWebhookIngest(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as MemoryWebhookHandlerDeps;
      const { jsonResponse } = d;
      const internalTok = (env.MEMORY_WEBHOOK_INTERNAL_TOKEN ?? "").trim();
      if (!internalTok) {
        return jsonResponse(
          { error: { code: "NOT_CONFIGURED", message: "Memory webhook ingest is not configured on this deployment" } },
          503,
        );
      }

      const rawBody = await request.text();
      const ip =
        request.headers.get("cf-connecting-ip") ??
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        "unknown";
      const rateIp = await rateLimit(`mem_webhook_ip:${ip}`, env, undefined, 120);
      if (!rateIp.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rateIp.headers);
      }

      const sigHeader = normalizeSignatureHeader(request.headers.get("x-mn-webhook-signature"));
      if (!sigHeader || !/^[0-9a-f]{64}$/i.test(sigHeader)) {
        return jsonResponse({ error: { code: "UNAUTHORIZED", message: "Missing or invalid X-MN-Webhook-Signature" } }, 401);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody) as unknown;
      } catch {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "Invalid JSON" } }, 400);
      }

      const parseResult = MemoryWebhookIngestSchema.safeParse(parsed);
      if (!parseResult.success) {
        const msg = parseResult.error.errors.map((e) => e.message).join("; ");
        return jsonResponse({ error: { code: "BAD_REQUEST", message: msg } }, 400);
      }
      const payload = parseResult.data;
      const { workspace_id, ...memoryBody } = payload;

      const secretRes = await supabase
        .from("memory_ingest_webhooks")
        .select("signing_secret")
        .eq("workspace_id", workspace_id)
        .maybeSingle();
      const signingSecret =
        typeof (secretRes.data as { signing_secret?: string } | null)?.signing_secret === "string"
          ? (secretRes.data as { signing_secret: string }).signing_secret
          : "";
      if (!signingSecret) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "Webhook signing secret not configured for workspace" } }, 404);
      }

      const expected = createHmac("sha256", signingSecret).update(rawBody, "utf8").digest("hex");
      const a = Buffer.from(expected, "hex");
      const b = Buffer.from(sigHeader, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return jsonResponse({ error: { code: "UNAUTHORIZED", message: "Invalid signature" } }, 401);
      }

      const rateWs = await rateLimit(`mem_webhook_ws:${workspace_id}`, env, undefined, 600);
      if (!rateWs.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rateWs.headers);
      }

      const memUrl = new URL("/v1/memories", request.url);
      const innerHeaders = new Headers(request.headers);
      innerHeaders.set("x-mn-ingest-internal", internalTok);
      innerHeaders.set("x-mn-webhook-workspace-id", workspace_id);
      innerHeaders.delete("x-mn-webhook-signature");
      innerHeaders.delete("x-api-key");
      innerHeaders.delete("authorization");

      const forwarded = new Request(memUrl.toString(), {
        method: "POST",
        headers: innerHeaders,
        body: JSON.stringify(memoryBody),
      });
      return d.handleCreateMemory(forwarded, env, supabase, auditCtx, requestId, deps);
    },
  };
}
