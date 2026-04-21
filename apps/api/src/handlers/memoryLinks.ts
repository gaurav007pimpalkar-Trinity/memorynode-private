/**
 * POST/DELETE /v1/memories/:id/links — capped typed links between memories.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import {
  authenticate,
  isTrustedInternal,
  rateLimit,
  rateLimitWorkspace,
} from "../auth.js";
import type { HandlerDeps } from "../router.js";
import { MemoryLinkCreateSchema, parseWithSchema } from "../contracts/index.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import type { MemoryHandlerDeps } from "./memories.js";
import { enforceIsolation } from "../middleware/isolation.js";
import { maybeRespondTrialExpiredWrite } from "../trialWrites.js";

const MAX_OUTBOUND_LINKS = 20;

export type MemoryLinkHandlerDeps = Pick<
  MemoryHandlerDeps,
  | "jsonResponse"
  | "resolveQuotaForWorkspace"
  | "reserveQuotaAndMaybeRespond"
  | "markUsageReservationCommitted"
  | "markUsageReservationRefundPending"
  | "todayUtc"
  | "getMemoryByIdScoped"
>;

export function createMemoryLinkHandlers(defaultDeps: MemoryLinkHandlerDeps): {
  handlePostMemoryLink: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    fromMemoryId: string,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDeleteMemoryLink: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    fromMemoryId: string,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handlePostMemoryLink(request, env, supabase, fromMemoryId, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as MemoryLinkHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      const trialEarly = maybeRespondTrialExpiredWrite(auth, env, jsonResponse);
      if (trialEarly) return trialEarly;
      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quota.blocked) {
        return jsonResponse(
          {
            error: {
              code: quota.errorCode ?? "ENTITLEMENT_REQUIRED",
              message: quota.message ?? "No active paid entitlement found.",
              upgrade_required: true,
              effective_plan: "launch",
            },
          },
          402,
        );
      }
      let rateHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
        const rate = await rateLimit(auth.keyHash, env, auth);
        if (!rate.allowed) {
          return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
        }
        const wsRpm = quota.planLimits.workspace_rpm ?? 120;
        const wsRate = await rateLimitWorkspace(auth.workspaceId, wsRpm, env);
        if (!wsRate.allowed) {
          return jsonResponse(
            { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
            429,
            { ...rate.headers, ...wsRate.headers },
          );
        }
        rateHeaders = { ...rate.headers, ...wsRate.headers };
      }

      const parseResult = await parseWithSchema(MemoryLinkCreateSchema, request);
      if (!parseResult.ok) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: parseResult.error,
              ...(parseResult.details ? { details: parseResult.details } : {}),
            },
          },
          400,
          rateHeaders,
        );
      }
      const { to_memory_id, link_type } = parseResult.data;

      const fromRow = await d.getMemoryByIdScoped(supabase, auth.workspaceId, fromMemoryId);
      if (!fromRow) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "from memory not found" } }, 404, rateHeaders);
      }
      const toRow = await d.getMemoryByIdScoped(supabase, auth.workspaceId, to_memory_id);
      if (!toRow) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "to memory not found" } }, 404, rateHeaders);
      }
      if (fromRow.user_id !== toRow.user_id || fromRow.namespace !== toRow.namespace) {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "memories must share user_id and namespace" } }, 400, rateHeaders);
      }
      if (fromRow.source_memory_id || toRow.source_memory_id) {
        return jsonResponse({ error: { code: "BAD_REQUEST", message: "cannot link extracted child memories" } }, 400, rateHeaders);
      }

      const isolationResolution = enforceIsolation(
        request,
        env,
        {
          user_id: fromRow.user_id,
          namespace: fromRow.namespace,
        },
        { scopedContainerTag: auth.scopedContainerTag ?? null },
      );
      const hdr = { ...rateHeaders, ...isolationResolution.responseHeaders };
      const ownerId = isolationResolution.isolation.ownerId;
      const ns = isolationResolution.isolation.containerTag;
      if (fromRow.user_id !== ownerId || fromRow.namespace !== ns) {
        return jsonResponse({ error: { code: "FORBIDDEN", message: "memory not in resolved isolation scope" } }, 403, hdr);
      }

      const listRes = await supabase
        .from("memory_links")
        .select("id")
        .eq("workspace_id", auth.workspaceId)
        .eq("from_memory_id", fromMemoryId);
      const existingCount = Array.isArray(listRes.data) ? listRes.data.length : 0;
      if (existingCount >= MAX_OUTBOUND_LINKS) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: `at most ${MAX_OUTBOUND_LINKS} outbound links per memory` } },
          400,
          hdr,
        );
      }

      const reserve = await d.reserveQuotaAndMaybeRespond(
        quota,
        supabase,
        auth.workspaceId,
        d.todayUtc(),
        { writesDelta: 1, readsDelta: 0, embedsDelta: 0, embedTokensDelta: 0, extractionCallsDelta: 0 },
        hdr,
        env,
        jsonResponse,
        { route: "/v1/memories/:id/links", requestId },
      );
      if (reserve.response) return reserve.response;
      const reservationId = reserve.reservationId;

      const ins = await supabase.from("memory_links").insert({
        workspace_id: auth.workspaceId,
        from_memory_id: fromMemoryId,
        to_memory_id,
        link_type,
      });
      if (ins.error) {
        const msg = ins.error.message ?? "insert failed";
        if (reservationId) await d.markUsageReservationRefundPending(supabase, reservationId, msg);
        if (/unique|duplicate/i.test(msg)) {
          return jsonResponse({ error: { code: "CONFLICT", message: "link already exists" } }, 409, hdr);
        }
        return jsonResponse({ error: { code: "DB_ERROR", message: msg } }, 500, hdr);
      }
      if (reservationId) await d.markUsageReservationCommitted(supabase, reservationId);
      return jsonResponse({ ok: true, from_memory_id: fromMemoryId, to_memory_id, link_type }, 200, hdr);
    },

    async handleDeleteMemoryLink(request, env, supabase, fromMemoryId, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as MemoryLinkHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      const trialEarly = maybeRespondTrialExpiredWrite(auth, env, jsonResponse);
      if (trialEarly) return trialEarly;
      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quota.blocked) {
        return jsonResponse(
          {
            error: {
              code: quota.errorCode ?? "ENTITLEMENT_REQUIRED",
              message: quota.message ?? "No active paid entitlement found.",
              upgrade_required: true,
              effective_plan: "launch",
            },
          },
          402,
        );
      }
      let rateHeaders: Record<string, string> = {};
      if (!isTrustedInternal(request, env)) {
        const rate = await rateLimit(auth.keyHash, env, auth);
        if (!rate.allowed) {
          return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
        }
        const wsRpm = quota.planLimits.workspace_rpm ?? 120;
        const wsRate = await rateLimitWorkspace(auth.workspaceId, wsRpm, env);
        if (!wsRate.allowed) {
          return jsonResponse(
            { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
            429,
            { ...rate.headers, ...wsRate.headers },
          );
        }
        rateHeaders = { ...rate.headers, ...wsRate.headers };
      }

      const url = new URL(request.url);
      const to_memory_id = (url.searchParams.get("to_memory_id") ?? "").trim();
      const link_type = (url.searchParams.get("link_type") ?? "").trim();
      if (!to_memory_id || !link_type) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "to_memory_id and link_type query params are required" } },
          400,
          rateHeaders,
        );
      }

      const fromRow = await d.getMemoryByIdScoped(supabase, auth.workspaceId, fromMemoryId);
      if (!fromRow) {
        return jsonResponse({ error: { code: "NOT_FOUND", message: "from memory not found" } }, 404, rateHeaders);
      }
      const isolationResolution = enforceIsolation(
        request,
        env,
        { user_id: fromRow.user_id, namespace: fromRow.namespace },
        { scopedContainerTag: auth.scopedContainerTag ?? null },
      );
      const hdr = { ...rateHeaders, ...isolationResolution.responseHeaders };
      const ownerId = isolationResolution.isolation.ownerId;
      const ns = isolationResolution.isolation.containerTag;
      if (fromRow.user_id !== ownerId || fromRow.namespace !== ns) {
        return jsonResponse({ error: { code: "FORBIDDEN", message: "memory not in resolved isolation scope" } }, 403, hdr);
      }

      const reserve = await d.reserveQuotaAndMaybeRespond(
        quota,
        supabase,
        auth.workspaceId,
        d.todayUtc(),
        { writesDelta: 1, readsDelta: 0, embedsDelta: 0, embedTokensDelta: 0, extractionCallsDelta: 0 },
        hdr,
        env,
        jsonResponse,
        { route: "/v1/memories/:id/links", requestId },
      );
      if (reserve.response) return reserve.response;
      const reservationId = reserve.reservationId;

      const del = await supabase
        .from("memory_links")
        .delete()
        .eq("workspace_id", auth.workspaceId)
        .eq("from_memory_id", fromMemoryId)
        .eq("to_memory_id", to_memory_id)
        .eq("link_type", link_type);
      if (del.error) {
        if (reservationId) await d.markUsageReservationRefundPending(supabase, reservationId, del.error.message ?? "");
        return jsonResponse({ error: { code: "DB_ERROR", message: del.error.message ?? "delete failed" } }, 500, hdr);
      }
      if (reservationId) await d.markUsageReservationCommitted(supabase, reservationId);
      return jsonResponse({ deleted: true, from_memory_id: fromMemoryId, to_memory_id, link_type }, 200, hdr);
    },
  };
}
