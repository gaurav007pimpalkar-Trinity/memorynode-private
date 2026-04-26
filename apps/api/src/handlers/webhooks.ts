/**
 * Billing webhook handler (PayU). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * PayU logic stays in index; dependencies injected via WebhookHandlerDeps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import { logger } from "../logger.js";
import type { HandlerDeps } from "../router.js";

export interface PayUWebhookPayloadLike {
  txnid?: string;
  status?: string;
  mihpayid?: string;
  [key: string]: unknown;
}

export interface ReconcileOutcomeLike {
  outcome: "processed" | "replayed" | "ignored_stale" | "deferred";
  payuEventId: string;
  eventType: string;
  eventCreated: number;
  workspaceId?: string | null;
  txnId?: string | null;
  replayStatus?: string | null;
  deferReason?: string | null;
}

export interface WebhookHandlerDeps extends HandlerDeps {
  resolveBillingWebhooksEnabled: (env: Env) => boolean;
  assertPayUEnvFor: (path: string, env: Env) => void;
  emitEventLog: (event_name: string, fields: Record<string, unknown>) => void;
  parseWebhookPayload: (rawBody: string, contentType: string) => PayUWebhookPayloadLike;
  asNonEmptyString: (raw: unknown) => string | null;
  isPayUWebhookSignatureValid: (
    payload: PayUWebhookPayloadLike,
    rawBody: string,
    request: Request,
    env: Env,
  ) => Promise<boolean>;
  resolvePayUEventId: (payload: PayUWebhookPayloadLike) => string;
  resolvePayUEventType: (payload: PayUWebhookPayloadLike) => string;
  resolvePayUEventCreated: (payload: PayUWebhookPayloadLike) => number;
  reconcilePayUWebhook: (
    payload: PayUWebhookPayloadLike,
    supabase: SupabaseClient,
    env: Env,
    requestId: string,
  ) => Promise<ReconcileOutcomeLike>;
  redact: (value: unknown, keyHint?: string) => unknown;
  logger: { error: (fields: Record<string, unknown>) => void };
  isApiError: (err: unknown) => err is { code: string; message: string; status?: number };
}

export function createWebhookHandlers(
  requestDeps: WebhookHandlerDeps,
  defaultDeps: WebhookHandlerDeps,
): {
  handleBillingWebhook: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleBillingWebhook(request, env, supabase, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as WebhookHandlerDeps;
      const { jsonResponse } = d;
      if (!d.resolveBillingWebhooksEnabled(env)) {
        d.emitEventLog("webhook_disabled", {
          route: "/v1/billing/webhook",
          method: "POST",
          status: 503,
          request_id: requestId || null,
        });
        return jsonResponse(
          {
            error: {
              code: "BILLING_WEBHOOKS_DISABLED",
              message: "Billing webhooks are temporarily disabled",
            },
            ...(requestId ? { request_id: requestId } : {}),
          },
          503,
        );
      }
      d.assertPayUEnvFor("/v1/billing/webhook", env);
      d.emitEventLog("webhook_received", {
        route: "/v1/billing/webhook",
        method: "POST",
        request_id: requestId || null,
        provider: "payu",
      });

      const rawBody = await request.text();
      const payload = d.parseWebhookPayload(rawBody, (request.headers.get("content-type") ?? "").toLowerCase());
      if (!d.asNonEmptyString(payload.txnid) || !d.asNonEmptyString(payload.status)) {
        return jsonResponse(
          {
            error: { code: "BAD_REQUEST", message: "txnid and status are required in PayU webhook payload" },
            ...(requestId ? { request_id: requestId } : {}),
          },
          400,
        );
      }

      try {
        const valid = await d.isPayUWebhookSignatureValid(payload, rawBody, request, env);
        if (!valid) {
          d.emitEventLog("billing_webhook_signature_invalid", {
            route: "/v1/billing/webhook",
            method: "POST",
            status: 403,
            request_id: requestId,
          });
          logger.error({
            event: "payu_webhook_signature_invalid",
            route: "/v1/billing/webhook",
            method: "POST",
            request_id: requestId || null,
            txnid_redacted: d.redact(payload.txnid, "payu_txn_id"),
          });
          return jsonResponse(
            {
              error: { code: "invalid_webhook_signature", message: "Invalid PayU signature" },
              ...(requestId ? { request_id: requestId } : {}),
            },
            403,
          );
        }
      } catch (err) {
        d.logger.error({
          event: "webhook_failed",
          route: "/v1/billing/webhook",
          method: "POST",
          status: 403,
          request_id: requestId || null,
          error_code: "invalid_webhook_signature",
          err,
        });
        logger.error({
          event: "payu_webhook_signature_validation_error",
          route: "/v1/billing/webhook",
          request_id: requestId || null,
          err,
        });
        return jsonResponse(
          {
            error: { code: "invalid_webhook_signature", message: "Invalid PayU signature" },
            ...(requestId ? { request_id: requestId } : {}),
          },
          403,
        );
      }

      try {
        const payuEventId = d.resolvePayUEventId(payload);
        const eventCreated = d.resolvePayUEventCreated(payload);
        d.emitEventLog("webhook_verified", {
          route: "/v1/billing/webhook",
          method: "POST",
          request_id: requestId || null,
          payu_event_id: payuEventId,
          event_type: d.resolvePayUEventType(payload),
          event_created: eventCreated,
          provider: "payu",
        });
        const outcome = await d.reconcilePayUWebhook(payload, supabase, env, requestId);
        if (outcome.outcome === "replayed") {
          d.emitEventLog("webhook_replayed", {
            route: "/v1/billing/webhook",
            method: "POST",
            status: 200,
            request_id: requestId || null,
            payu_event_id: outcome.payuEventId,
            event_type: outcome.eventType,
            event_created: outcome.eventCreated,
            replay_status: outcome.replayStatus ?? null,
          });
          logger.info({
            event: "payu_webhook_idempotent",
            route: "/v1/billing/webhook",
            request_id: requestId || null,
            payu_event_id: outcome.payuEventId,
            replay_status: outcome.replayStatus ?? null,
          });
        } else {
          if (outcome.outcome === "deferred") {
            d.emitEventLog("webhook_deferred", {
              route: "/v1/billing/webhook",
              method: "POST",
              status: 202,
              request_id: requestId || null,
              payu_event_id: outcome.payuEventId,
              event_type: outcome.eventType,
              event_created: outcome.eventCreated,
              reason: outcome.deferReason ?? "workspace_not_found",
              txn_id_redacted: d.redact(outcome.txnId, "payu_txn_id"),
            });
            logger.info({
              event: "payu_webhook_deferred",
              route: "/v1/billing/webhook",
              request_id: requestId || null,
              payu_event_id: outcome.payuEventId,
              reason: outcome.deferReason ?? "workspace_not_found",
            });
            return jsonResponse(
              {
                error: {
                  code: "webhook_deferred",
                  message: "Webhook deferred until workspace mapping is available",
                },
                ...(requestId ? { request_id: requestId } : {}),
              },
              202,
            );
          }
          d.emitEventLog("webhook_processed", {
            route: "/v1/billing/webhook",
            method: "POST",
            status: 200,
            request_id: requestId || null,
            payu_event_id: outcome.payuEventId,
            event_type: outcome.eventType,
            event_created: outcome.eventCreated,
            outcome: outcome.outcome,
            workspace_id: outcome.workspaceId ?? null,
          });
          logger.info({
            event: "payu_webhook_success",
            route: "/v1/billing/webhook",
            request_id: requestId || null,
            payu_event_id: outcome.payuEventId,
            event_type: outcome.eventType,
            outcome: outcome.outcome,
            workspace_id: outcome.workspaceId ?? null,
          });
        }
      } catch (err) {
        const maybeEvent = err as { payu_event_id?: unknown; event_type?: unknown };
        logger.error({
          event: "payu_webhook_processing_failed",
          route: "/v1/billing/webhook",
          request_id: requestId || null,
          payu_event_id:
            typeof maybeEvent.payu_event_id === "string" ? maybeEvent.payu_event_id : null,
          last_error: d.redact(err instanceof Error ? err.message : String(err), "message"),
          err,
        });
        d.logger.error({
          event: "webhook_failed",
          route: "/v1/billing/webhook",
          method: "POST",
          status: d.isApiError(err) ? (err as { status?: number }).status ?? 500 : 500,
          request_id: requestId || null,
          payu_event_id:
            typeof maybeEvent.payu_event_id === "string" ? maybeEvent.payu_event_id : null,
          event_type: typeof maybeEvent.event_type === "string" ? maybeEvent.event_type : null,
          err,
        });
        if (d.isApiError(err)) {
          const apiErr = err as { code: string; message: string; status?: number };
          return jsonResponse(
            {
              error: { code: apiErr.code, message: apiErr.message },
              ...(requestId ? { request_id: requestId } : {}),
            },
            apiErr.status ?? 500,
          );
        }
        return jsonResponse(
          {
            error: { code: "INTERNAL", message: "Failed to process webhook" },
            ...(requestId ? { request_id: requestId } : {}),
          },
          500,
        );
      }

      return jsonResponse({ received: true }, 200);
    },
  };
}
