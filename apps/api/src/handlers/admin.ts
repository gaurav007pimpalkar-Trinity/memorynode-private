/**
 * Admin handlers (reprocess deferred webhooks, billing health). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * PayU/billing logic stays in index; dependencies injected via AdminHandlerDeps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { HandlerDeps } from "../router.js";
import type { PayUWebhookPayloadLike } from "./webhooks.js";
import type { ReconcileOutcomeLike } from "./webhooks.js";
import { createHttpError } from "../http.js";

function extractClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export interface AdminHandlerDeps extends HandlerDeps {
  requireAdmin: (request: Request, env: Env) => Promise<{ token: string }>;
  rateLimit: (keyHash: string, env: Env, auth?: { keyCreatedAt?: string | null }) => Promise<{ allowed: boolean; headers: Record<string, string> }>;
  emitEventLog: (event_name: string, fields: Record<string, unknown>) => void;
  redact: (value: unknown, keyHint?: string) => unknown;
  getFounderPhase1Metrics: (
    supabase: SupabaseClient,
    range: "24h" | "7d" | "30d",
  ) => Promise<Record<string, unknown>>;
  reconcilePayUWebhook: (
    payload: PayUWebhookPayloadLike,
    supabase: SupabaseClient,
    env: Env,
    requestId: string,
    forcedEventId?: string,
  ) => Promise<ReconcileOutcomeLike>;
  defaultWebhookReprocessLimit: number;
  asNonEmptyString: (raw: unknown) => string | null;
  resolvePayUVerifyTimeoutMs: (env: Env) => number;
  resolveBillingWebhooksEnabled: (env: Env) => boolean;
  normalizeCurrency: (raw: string | undefined) => string;
}

export function createAdminHandlers(
  requestDeps: AdminHandlerDeps,
  defaultDeps: AdminHandlerDeps,
): {
  handleReconcileUsageRefunds: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleReprocessDeferredWebhooks: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleAdminBillingHealth: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleFounderPhase1Metrics: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleCleanupExpiredSessions: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleMemoryHygiene: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  async function guardAdminIp(request: Request, env: Env, d: AdminHandlerDeps): Promise<void> {
    const ip = extractClientIp(request);
    const ipRate = await d.rateLimit(`admin-ip:${ip}`, env);
    if (!ipRate.allowed) {
      throw createHttpError(429, "RATE_LIMITED", "Too many admin requests from this IP");
    }
  }

  return {
    async handleReconcileUsageRefunds(request, env, supabase, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as AdminHandlerDeps;
      const { jsonResponse } = d;
      await guardAdminIp(request, env, d);
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:usage-refunds:${token}`, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const url = new URL(request.url);
      const parsedLimit = Number(url.searchParams.get("limit") ?? "100");
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(1000, Math.floor(parsedLimit)))
        : 100;

      const { data, error } = await supabase.rpc("process_usage_reservation_refunds", {
        p_limit: limit,
      });
      if (error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error.message ?? "Failed to process usage refunds" } },
          500,
          rate.headers,
        );
      }
      const rows = (Array.isArray(data) ? data : []) as Array<{
        reservation_id?: string | null;
        status?: string | null;
        error_message?: string | null;
      }>;
      const refunded = rows.filter((r) => (r.status ?? "") === "refunded").length;
      const failed = rows.filter((r) => (r.status ?? "") === "failed").length;
      d.emitEventLog("usage_refunds_reconciled", {
        route: "/admin/usage/reconcile",
        method: "POST",
        request_id: requestId || null,
        scanned: rows.length,
        refunded,
        failed,
        limit,
      });
      return jsonResponse(
        {
          scanned: rows.length,
          refunded,
          failed,
          results: rows.map((r) => ({
            reservation_id: r.reservation_id ?? null,
            status: r.status ?? null,
            error_message: r.error_message ?? null,
          })),
        },
        200,
        rate.headers,
      );
    },

    async handleCleanupExpiredSessions(request, env, supabase, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as AdminHandlerDeps;
      const { jsonResponse } = d;
      await guardAdminIp(request, env, d);
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:sessions:${token}`, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }
      const nowIso = new Date().toISOString();
      const { data: deletedRows, error } = await supabase
        .from("dashboard_sessions")
        .delete()
        .lt("expires_at", nowIso)
        .select("id");
      if (error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error.message ?? "Failed to delete expired sessions" } },
          500,
          rate.headers,
        );
      }
      const deleted = Array.isArray(deletedRows) ? deletedRows.length : 0;
      d.emitEventLog("dashboard_sessions_cleanup", {
        route: "/admin/sessions/cleanup",
        request_id: requestId || null,
        deleted,
      });
      return jsonResponse({ ok: true, deleted }, 200, rate.headers);
    },

    async handleReprocessDeferredWebhooks(request, env, supabase, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as AdminHandlerDeps;
      const { jsonResponse } = d;
      await guardAdminIp(request, env, d);
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:${token}`, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const url = new URL(request.url);
      const statusFilterRaw = (url.searchParams.get("status") ?? "deferred").trim().toLowerCase();
      if (statusFilterRaw !== "deferred" && statusFilterRaw !== "failed") {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "status must be one of: deferred, failed" } },
          400,
          rate.headers,
        );
      }
      const parsedLimit = Number(url.searchParams.get("limit") ?? d.defaultWebhookReprocessLimit);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(500, Math.floor(parsedLimit)))
        : d.defaultWebhookReprocessLimit;

      d.emitEventLog("webhook_reprocess_started", {
        route: "/admin/webhooks/reprocess",
        method: "POST",
        request_id: requestId || null,
        status_filter: statusFilterRaw,
        limit,
      });

      const pending = await supabase
        .from("payu_webhook_events")
        .select("event_id,payload,event_created")
        .eq("status", statusFilterRaw)
        .order("event_created", { ascending: true })
        .limit(limit);
      if (pending.error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: pending.error.message ?? "Failed to list deferred webhooks" } },
          500,
          rate.headers,
        );
      }

      const rows = ((pending.data as Array<{ event_id?: unknown; payload?: unknown }> | null) ?? [])
        .filter((row) => typeof row.event_id === "string" && (row.event_id as string).trim().length > 0) as Array<{
        event_id: string;
        payload?: unknown;
        event_created?: number | null;
      }>;

      let processed = 0;
      let replayed = 0;
      let deferred = 0;
      let failed = 0;

      for (const row of rows) {
        try {
          const payload = (row.payload ?? {}) as PayUWebhookPayloadLike;
          const outcome = await d.reconcilePayUWebhook(
            payload,
            supabase,
            env,
            `${requestId || "admin-reprocess"}:${row.event_id}`,
            row.event_id,
          );
          if (outcome.outcome === "replayed") {
            replayed += 1;
            d.emitEventLog("webhook_reprocess_skipped", {
              route: "/admin/webhooks/reprocess",
              method: "POST",
              request_id: requestId || null,
              payu_event_id: row.event_id,
              replay_status: outcome.replayStatus ?? null,
            });
            continue;
          }
          if (outcome.outcome === "deferred") {
            deferred += 1;
            d.emitEventLog("webhook_reprocess_skipped", {
              route: "/admin/webhooks/reprocess",
              method: "POST",
              request_id: requestId || null,
              payu_event_id: row.event_id,
              reason: outcome.deferReason ?? "workspace_not_found",
            });
            continue;
          }
          processed += 1;
          d.emitEventLog("webhook_reprocess_processed", {
            route: "/admin/webhooks/reprocess",
            method: "POST",
            request_id: requestId || null,
            payu_event_id: row.event_id,
            outcome: outcome.outcome,
          });
        } catch (err) {
          failed += 1;
          d.emitEventLog("webhook_reprocess_failed", {
            route: "/admin/webhooks/reprocess",
            method: "POST",
            request_id: requestId || null,
            payu_event_id: row.event_id,
            error_message: d.redact((err as Error)?.message, "message"),
          });
        }
      }

      return jsonResponse(
        {
          scanned: rows.length,
          processed,
          replayed,
          deferred,
          failed,
          status_filter: statusFilterRaw,
        },
        200,
        rate.headers,
      );
    },

    async handleAdminBillingHealth(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as AdminHandlerDeps;
      const { jsonResponse } = d;
      await guardAdminIp(request, env, d);
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:${token}`, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const nowIso = new Date().toISOString();
      const verifyUrl = d.asNonEmptyString(env.PAYU_VERIFY_URL);
      let verifyHost: string | null = null;
      if (verifyUrl) {
        try {
          verifyHost = new URL(verifyUrl).host;
        } catch {
          verifyHost = null;
        }
      }

      const dbProbe = await supabase.from("workspaces").select("id").limit(1);
      const dbConnectivity = {
        ok: !dbProbe.error,
        error_code: dbProbe.error?.code ?? null,
        error_message: dbProbe.error ? d.redact(dbProbe.error.message ?? "DB probe failed", "message") : null,
      };

      const webhookRows = await supabase
        .from("payu_webhook_events")
        .select("event_id,status,payu_status,event_created,processed_at,defer_reason,last_error")
        .order("event_created", { ascending: false })
        .limit(10);
      const webhookSummary = {
        ok: !webhookRows.error,
        error_code: webhookRows.error?.code ?? null,
        error_message: webhookRows.error ? d.redact(webhookRows.error.message ?? "Webhook query failed", "message") : null,
        items: ((webhookRows.data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
          event_id_redacted: d.redact(row.event_id, "payu_event_id"),
          status: typeof row.status === "string" ? row.status : null,
          payu_status: typeof row.payu_status === "string" ? row.payu_status : null,
          event_created: typeof row.event_created === "number" ? row.event_created : null,
          processed_at: typeof row.processed_at === "string" ? row.processed_at : null,
          defer_reason: typeof row.defer_reason === "string" ? row.defer_reason : null,
          last_error: typeof row.last_error === "string" ? d.redact(row.last_error, "message") : null,
        })),
      };

      const txnRows = await supabase
        .from("payu_transactions")
        .select("txn_id,workspace_id,plan_code,status,amount,currency,verify_status,updated_at,last_error")
        .order("updated_at", { ascending: false })
        .limit(10);
      const transactionSummary = {
        ok: !txnRows.error,
        error_code: txnRows.error?.code ?? null,
        error_message: txnRows.error ? d.redact(txnRows.error.message ?? "Transaction query failed", "message") : null,
        items: ((txnRows.data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
          txn_id_redacted: d.redact(row.txn_id, "payu_txn_id"),
          workspace_id_redacted: d.redact(row.workspace_id, "workspace_id"),
          plan_code: typeof row.plan_code === "string" ? row.plan_code : null,
          status: typeof row.status === "string" ? row.status : null,
          amount: typeof row.amount === "number" || typeof row.amount === "string" ? String(row.amount) : null,
          currency: typeof row.currency === "string" ? row.currency : null,
          verify_status: typeof row.verify_status === "string" ? row.verify_status : null,
          updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
          last_error: typeof row.last_error === "string" ? d.redact(row.last_error, "message") : null,
        })),
      };

      return jsonResponse(
        {
          now: nowIso,
          billing_webhooks_enabled: d.resolveBillingWebhooksEnabled(env),
          payu_verify: {
            configured: Boolean(verifyUrl),
            host: verifyHost,
            timeout_ms: d.resolvePayUVerifyTimeoutMs(env),
            currency: d.normalizeCurrency(env.PAYU_CURRENCY),
          },
          db_connectivity: dbConnectivity,
          payu_webhook_events: webhookSummary,
          payu_transactions: transactionSummary,
        },
        200,
        rate.headers,
      );
    },

    async handleFounderPhase1Metrics(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as AdminHandlerDeps;
      const { jsonResponse } = d;
      await guardAdminIp(request, env, d);
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:founder-phase1:${token}`, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const url = new URL(request.url);
      const rangeRaw = (url.searchParams.get("range") ?? "7d").trim().toLowerCase();
      if (rangeRaw !== "24h" && rangeRaw !== "7d" && rangeRaw !== "30d") {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "range must be one of: 24h, 7d, 30d" } },
          400,
          rate.headers,
        );
      }

      const metrics = await d.getFounderPhase1Metrics(supabase, rangeRaw);
      return jsonResponse(metrics, 200, rate.headers);
    },

    /**
     * Memory hygiene: detect near-duplicate memories via embedding similarity.
     * Marks lower-priority duplicate with duplicate_of; never auto-deletes.
     * Designed to be triggered weekly via cron or manual admin call.
     *
     * POST /admin/memory-hygiene
     * Query params: workspace_id (required), similarity_threshold (0.80-0.99, default 0.92), limit (1-500, default 200), dry_run (true/false, default true)
     */
    async handleMemoryHygiene(request, env, supabase, requestId = "", deps?) {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const d = (deps ?? defaultDeps) as AdminHandlerDeps;
      const { jsonResponse } = d;
      await guardAdminIp(request, env, d);
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:hygiene:${token}`, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const url = new URL(request.url);
      const workspaceId = url.searchParams.get("workspace_id")?.trim();
      if (!workspaceId) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "workspace_id query parameter is required" } },
          400,
          rate.headers,
        );
      }
      if (!UUID_RE.test(workspaceId)) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "workspace_id must be a valid UUID" } },
          400,
          rate.headers,
        );
      }

      const rawThreshold = Number(url.searchParams.get("similarity_threshold") ?? 0.92);
      const similarityThreshold = Number.isFinite(rawThreshold) && rawThreshold >= 0.80 && rawThreshold <= 0.99
        ? rawThreshold
        : 0.92;

      const rawLimit = Number(url.searchParams.get("limit") ?? 200);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 200;

      const dryRun = url.searchParams.get("dry_run")?.toLowerCase() !== "false";

      d.emitEventLog("memory_hygiene_started", {
        route: "/admin/memory-hygiene",
        request_id: requestId || null,
        workspace_id: workspaceId,
        similarity_threshold: similarityThreshold,
        limit,
        dry_run: dryRun,
      });

      const { data: pairs, error: rpcError } = await supabase.rpc("find_near_duplicate_memories", {
        p_workspace_id: workspaceId,
        p_similarity_threshold: similarityThreshold,
        p_limit: limit,
      });

      if (rpcError) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: rpcError.message ?? "Duplicate detection RPC failed" } },
          500,
          rate.headers,
        );
      }

      const duplicatePairs = (pairs ?? []) as Array<{
        memory_id_a: string;
        memory_id_b: string;
        similarity: number;
        chunk_text_a: string;
        chunk_text_b: string;
      }>;

      let marked = 0;
      if (!dryRun) {
        for (const pair of duplicatePairs) {
          const { error: updateErr } = await supabase
            .from("memories")
            .update({ duplicate_of: pair.memory_id_a })
            .eq("id", pair.memory_id_b)
            .eq("workspace_id", workspaceId)
            .is("duplicate_of", null);

          if (!updateErr) marked++;
        }
      }

      d.emitEventLog("memory_hygiene_completed", {
        route: "/admin/memory-hygiene",
        request_id: requestId || null,
        workspace_id: workspaceId,
        duplicates_found: duplicatePairs.length,
        marked,
        dry_run: dryRun,
      });

      return jsonResponse(
        {
          workspace_id: workspaceId,
          duplicates_found: duplicatePairs.length,
          marked,
          dry_run: dryRun,
          similarity_threshold: similarityThreshold,
          pairs: duplicatePairs.map((p) => ({
            memory_id_a: p.memory_id_a,
            memory_id_b: p.memory_id_b,
            similarity: Math.round(p.similarity * 1000) / 1000,
            preview_a: p.chunk_text_a?.slice(0, 120) ?? "",
            preview_b: p.chunk_text_b?.slice(0, 120) ?? "",
          })),
        },
        200,
        rate.headers,
      );
    },
  };
}
