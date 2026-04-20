/**
 * Import handler (artifact_base64 + mode). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * Dependencies injected via ImportHandlerDeps to avoid circular dependency with index.
 * Phase 6: Pre-calc deltas, atomic cap RPC before insert, 402 if over cap.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import {
  acquireWorkspaceConcurrencySlot,
  authenticate,
  rateLimit,
  releaseWorkspaceConcurrencySlot,
} from "../auth.js";
import { getRouteRateLimitMax } from "../limits.js";
import type { HandlerDeps } from "../router.js";
import { ImportPayloadSchema, parseWithSchema } from "../contracts/index.js";
import type { ImportMode, ImportPayload } from "../contracts/index.js";
import type { QuotaResolutionLike } from "./memories.js";
import { enforceIsolation } from "../middleware/isolation.js";

export type { ImportMode, ImportPayload };
export type ImportPayloadLike = ImportPayload;

export interface ImportOutcomeLike {
  imported_memories: number;
  imported_chunks: number;
}

export type ImportOutcomeWithCap =
  | ImportOutcomeLike
  | { cap_exceeded: true; response: Response };

export interface ImportHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  resolveQuotaForWorkspace: (auth: AuthContext, supabase: SupabaseClient) => Promise<QuotaResolutionLike>;
  rateLimitWorkspace: (workspaceId: string, workspaceRpm: number, env: Env) => Promise<{ allowed: boolean; headers: Record<string, string> }>;
  reserveQuotaAndMaybeRespond: (
    quota: QuotaResolutionLike,
    supabase: SupabaseClient,
    workspaceId: string,
    day: string,
    deltas: {
      writesDelta: number;
      readsDelta: number;
      embedsDelta: number;
      embedTokensDelta: number;
      extractionCallsDelta: number;
    },
    rateHeaders: Record<string, string> | undefined,
    env: Env,
    jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
    meta?: { route?: string; requestId?: string },
  ) => Promise<{ response: Response | null; reservationId: string | null }>;
  markUsageReservationCommitted: (
    supabase: SupabaseClient,
    reservationId: string,
  ) => Promise<void>;
  markUsageReservationRefundPending: (
    supabase: SupabaseClient,
    reservationId: string,
    errorMessage: string,
  ) => Promise<void>;
  todayUtc: () => string;
  importArtifact: (
    auth: AuthContext,
    supabase: SupabaseClient,
    artifactBase64: string,
    maxBytes: number,
    mode?: ImportMode,
    options?: {
      preInsertGuard?: (deltas: {
        writesDelta: number;
        readsDelta: number;
        embedsDelta: number;
        embedTokensDelta: number;
        extractionCallsDelta: number;
      }) => Promise<{ response: Response | null; reservationId: string | null }>;
    },
  ) => Promise<ImportOutcomeWithCap | (ImportOutcomeLike & { reservation_id?: string | null })>;
  defaultMaxImportBytes: number;
}

export function createImportHandlers(
  requestDeps: ImportHandlerDeps,
  defaultDeps: ImportHandlerDeps,
): {
  handleImport: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleImport(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as ImportHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "import", auth.keyCreatedAt));
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      const parseResult = await parseWithSchema(ImportPayloadSchema, request);
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
          rate.headers,
        );
      }
      const payload = parseResult.data;

      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quota.blocked) {
        return jsonResponse(
          {
            error: {
              code: quota.errorCode ?? "ENTITLEMENT_REQUIRED",
              message: quota.message ?? "No active paid entitlement found. Start a plan to continue quota-consuming API calls.",
              upgrade_required: true,
              effective_plan: "launch",
            },
            upgrade_url: (env as { PUBLIC_APP_URL?: string }).PUBLIC_APP_URL
              ? `${(env as { PUBLIC_APP_URL: string }).PUBLIC_APP_URL}/billing`
              : undefined,
          },
          402,
        );
      }
      const wsRpm = quota.planLimits.workspace_rpm ?? 120;
      const wsRate = await d.rateLimitWorkspace(auth.workspaceId, wsRpm, env);
      if (!wsRate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
          429,
          { ...rate.headers, ...wsRate.headers },
        );
      }
      const isolationResolution = enforceIsolation(
        request,
        env,
        {
          userId: request.headers.get("x-mn-user-id"),
          scope: request.headers.get("x-mn-scope"),
          containerTag: request.headers.get("x-mn-container-tag"),
        },
        { scopedContainerTag: auth.scopedContainerTag ?? null },
      );
      const rateHeaders = { ...rate.headers, ...wsRate.headers, ...isolationResolution.responseHeaders };
      const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toLowerCase();
      const enforceDegradedBlocks = stage === "production" || stage === "prod" || stage === "staging";
      if (enforceDegradedBlocks && quota.degradedEntitlements) {
        return jsonResponse(
          {
            error: {
              code: "ENTITLEMENT_DEGRADED",
              message: "Import is temporarily unavailable while entitlement checks recover.",
            },
          },
          503,
          rateHeaders,
        );
      }
      const concurrency = await acquireWorkspaceConcurrencySlot(auth.workspaceId, env);
      if (!concurrency.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace in-flight concurrency limit exceeded" } },
          429,
          { ...rateHeaders, ...concurrency.headers },
        );
      }
      const concurrencyHeaders = { ...rateHeaders, ...concurrency.headers };
      let reservationIdFromGuard: string | null = null;
      const preInsertGuard = async (deltas: {
        writesDelta: number;
        readsDelta: number;
        embedsDelta: number;
        embedTokensDelta: number;
        extractionCallsDelta: number;
      }) => {
        const reserveResult = await d.reserveQuotaAndMaybeRespond(
          quota,
          supabase,
          auth.workspaceId,
          d.todayUtc(),
          deltas,
          concurrencyHeaders,
          env,
          jsonResponse,
          { route: "/v1/import", requestId },
        );
        reservationIdFromGuard = reserveResult.reservationId;
        return reserveResult;
      };
      const maxBytes = Number(env.MAX_IMPORT_BYTES ?? d.defaultMaxImportBytes);
      let outcome: ImportOutcomeWithCap | (ImportOutcomeLike & { reservation_id?: string | null });
      try {
        try {
          outcome = await d.importArtifact(
            auth,
            supabase,
            payload.artifact_base64,
            maxBytes,
            payload.mode,
            { preInsertGuard },
          ) as ImportOutcomeWithCap | (ImportOutcomeLike & { reservation_id?: string | null });
        } catch (err) {
          if (reservationIdFromGuard) {
            await d.markUsageReservationRefundPending(
              supabase,
              reservationIdFromGuard,
              err instanceof Error ? err.message : String(err),
            );
          }
          throw err;
        }

        if ("cap_exceeded" in outcome && outcome.cap_exceeded) {
          return outcome.response;
        }
        const reservationId =
          (outcome as unknown as { reservation_id?: string | null }).reservation_id ??
          reservationIdFromGuard;
        const success = outcome as ImportOutcomeLike;
        if (reservationId) {
          await d.markUsageReservationCommitted(supabase, reservationId);
        }
        return jsonResponse(
          { imported_memories: success.imported_memories, imported_chunks: success.imported_chunks },
          200,
          concurrencyHeaders,
        );
      } finally {
        await releaseWorkspaceConcurrencySlot(auth.workspaceId, concurrency.leaseToken, env);
      }
    },
  };
}
