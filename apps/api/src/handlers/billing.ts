/**
 * Billing handlers (status, checkout, portal). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * PayU logic stays in index; dependencies injected via BillingHandlerDeps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { AuthContext } from "../auth.js";
import { authenticate, rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";

const CHECKOUT_PLAN_IDS = ["launch", "build", "deploy", "scale", "scale_plus"] as const;

export interface BillingHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  normalizePlanStatus: (raw: string | null | undefined) => AuthContext["planStatus"];
  resolveQuotaForWorkspace: (auth: AuthContext, supabase: SupabaseClient) => Promise<QuotaResolutionLike>;
  emitEventLog: (event_name: string, fields: Record<string, unknown>) => void;
  redact: (value: unknown, keyHint?: string) => unknown;
  isPayUBillingConfigured: (env: Env) => boolean;
  assertPayUEnvFor: (path: string, env: Env) => void;
  shortHash: (value: string, length?: number) => Promise<string>;
  fetchPayUTransactionByTxnId: (supabase: SupabaseClient, txnId: string) => Promise<PayUTransactionLike | null>;
  formatAmountStrict: (raw: unknown) => string;
  normalizeCurrency: (raw: string | undefined) => string;
  transitionPayUTransactionStatus: (
    supabase: SupabaseClient,
    txnId: string,
    next: string,
    fields?: { requestId?: string | null; lastError?: string | null },
  ) => Promise<string>;
  buildPayURequestHashInput: (fields: PayURequestHashFieldsLike) => string;
  computeSha512Hex: (input: string) => Promise<string>;
  normalizePayUBaseUrl: (raw: string) => string;
  emitProductEvent: (
    supabase: SupabaseClient,
    eventName: string,
    ctx: Record<string, unknown>,
    props?: Record<string, unknown>,
  ) => Promise<void>;
  resolveEntitlementPlanCode: (plan: string) => string;
  getAmountForPlan: (planCode: string, env: Env) => string;
  getProductInfoForPlan: (planCode: string, env: Env) => string;
  defaultSuccessPath: string;
  defaultCancelPath: string;
  defaultProductInfo: string;
}

export interface QuotaResolutionLike {
  caps: { writes: number; reads: number; embeds: number };
  effectivePlan: string;
  planStatus: AuthContext["planStatus"];
  blocked: boolean;
}

export interface PayUTransactionLike {
  workspace_id: string;
  amount: number | string;
  currency: string;
}

export interface PayURequestHashFieldsLike {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  salt: string;
}

export function createBillingHandlers(
  requestDeps: BillingHandlerDeps,
  defaultDeps: BillingHandlerDeps,
): {
  handleBillingStatus: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleBillingCheckout: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleBillingPortal: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleBillingStatus(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as BillingHandlerDeps;
      const { jsonResponse } = d;
      if (!d.isPayUBillingConfigured(env)) {
        return jsonResponse(
          { error: { code: "BILLING_NOT_CONFIGURED", message: "Missing PayU configuration" } },
          503,
        );
      }
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const { data, error } = await supabase
        .from("workspaces")
        .select("plan, plan_status, current_period_end, cancel_at_period_end")
        .eq("id", auth.workspaceId)
        .single();

      if (error || !data) {
        d.emitEventLog("billing_endpoint_error", {
          route: "/v1/billing/status",
          method: "GET",
          status: 500,
          request_id: requestId,
          workspace_id_redacted: d.redact(auth.workspaceId, "workspace_id"),
        });
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error?.message ?? "Failed to load billing status" } },
          500,
          rate.headers,
        );
      }

      const row = data as { plan?: string; plan_status?: string; current_period_end?: string | null; cancel_at_period_end?: boolean };
      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      return jsonResponse(
        {
          plan: row.plan ?? "free",
          plan_status: d.normalizePlanStatus(row.plan_status) ?? "free",
          current_period_end: row.current_period_end ?? null,
          cancel_at_period_end: row.cancel_at_period_end ?? false,
          effective_plan: quota.effectivePlan,
        },
        200,
        rate.headers,
      );
    },

    async handleBillingCheckout(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as BillingHandlerDeps;
      const { jsonResponse } = d;
      const parsedBody = await d.safeParseJson<{ plan?: string; firstname?: string; email?: string; phone?: string }>(request);
      const requestedPlan = parsedBody.ok ? parsedBody.data.plan : undefined;
      if (requestedPlan != null && requestedPlan !== "" && !CHECKOUT_PLAN_IDS.includes(requestedPlan as (typeof CHECKOUT_PLAN_IDS)[number])) {
        return jsonResponse(
          {
            error: {
              code: "PLAN_NOT_SUPPORTED",
              message: `Allowed plans: ${CHECKOUT_PLAN_IDS.join(", ")}. Pro/team are no longer available; use platform plans.`,
            },
          },
          400,
        );
      }
      d.assertPayUEnvFor("/v1/billing/checkout", env);

      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const { data, error } = await supabase
        .from("workspaces")
        .select("id")
        .eq("id", auth.workspaceId)
        .single();

      if (error || !data) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error?.message ?? "Failed to load workspace" } },
          500,
          rate.headers,
        );
      }

      const planCode = d.resolveEntitlementPlanCode(requestedPlan ?? "build");
      const monthKey = new Date().toISOString().slice(0, 7).replace("-", "");
      const clientIdem = request.headers.get("Idempotency-Key") ?? request.headers.get("idempotency-key");
      const workspaceHash = await d.shortHash(auth.workspaceId, 8);
      const idemHash = clientIdem ? await d.shortHash(clientIdem, 8) : "default1";
      const txnId = `mn${monthKey}${workspaceHash}${idemHash}`.slice(0, 40);
      const amount = d.getAmountForPlan(planCode, env);
      const currency = d.normalizeCurrency(env.PAYU_CURRENCY);

      const existingTxn = await d.fetchPayUTransactionByTxnId(supabase, txnId);
      if (existingTxn) {
        if (existingTxn.workspace_id !== auth.workspaceId) {
          return jsonResponse(
            { error: { code: "CONFLICT", message: "Existing transaction id belongs to a different workspace" } },
            409,
            rate.headers,
          );
        }
        if (
          d.formatAmountStrict(existingTxn.amount) !== amount ||
          d.normalizeCurrency(existingTxn.currency) !== currency
        ) {
          return jsonResponse(
            { error: { code: "CONFLICT", message: "Existing transaction metadata mismatch for idempotency key" } },
            409,
            rate.headers,
          );
        }
      } else {
        const createdTxn = await supabase.from("payu_transactions").insert({
          txn_id: txnId,
          workspace_id: auth.workspaceId,
          plan_code: planCode,
          amount,
          currency,
          status: "created",
          request_id: requestId || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        if (createdTxn.error) {
          return jsonResponse(
            { error: { code: "DB_ERROR", message: createdTxn.error.message ?? "Failed to create transaction row" } },
            500,
            rate.headers,
          );
        }
      }

      await d.transitionPayUTransactionStatus(supabase, txnId, "initiated", {
        requestId: requestId || null,
        lastError: null,
      });

      const updatedWorkspace = await supabase
        .from("workspaces")
        .update({
          billing_provider: "payu",
          payu_txn_id: txnId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", auth.workspaceId);
      if (updatedWorkspace.error) {
        d.emitEventLog("billing_endpoint_error", {
          route: "/v1/billing/checkout",
          method: "POST",
          status: 500,
          request_id: requestId,
          workspace_id_redacted: d.redact(auth.workspaceId, "workspace_id"),
        });
        return jsonResponse(
          { error: { code: "DB_ERROR", message: updatedWorkspace.error.message ?? "Failed to persist PayU transaction id" } },
          500,
          rate.headers,
        );
      }

      const successUrl = new URL(env.PAYU_SUCCESS_PATH ?? d.defaultSuccessPath, env.PUBLIC_APP_URL!).toString();
      const cancelUrl = new URL(env.PAYU_CANCEL_PATH ?? d.defaultCancelPath, env.PUBLIC_APP_URL!).toString();
      const productInfo = d.getProductInfoForPlan(planCode, env);
      const firstname = (parsedBody.ok ? parsedBody.data.firstname : undefined)?.trim() || "MemoryNode";
      const email = (parsedBody.ok ? parsedBody.data.email : undefined)?.trim() || `${auth.workspaceId}@payu.local`;
      const phone = (parsedBody.ok ? parsedBody.data.phone : undefined)?.trim() || "";

      const hashInput = d.buildPayURequestHashInput({
        key: env.PAYU_MERCHANT_KEY!,
        txnid: txnId,
        amount,
        productinfo: productInfo,
        firstname,
        email,
        udf1: auth.workspaceId,
        udf2: planCode,
        udf3: "",
        udf4: "",
        udf5: "",
        salt: env.PAYU_MERCHANT_SALT!,
      });
      const hash = await d.computeSha512Hex(hashInput);

      const checkoutFields = {
        key: env.PAYU_MERCHANT_KEY!,
        txnid: txnId,
        amount,
        productinfo: productInfo,
        firstname,
        email,
        phone,
        currency,
        surl: successUrl,
        furl: cancelUrl,
        hash,
        udf1: auth.workspaceId,
        udf2: planCode,
        udf3: "",
        udf4: "",
        udf5: "",
      };

      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      void d.emitProductEvent(
        supabase,
        "checkout_started",
        {
          workspaceId: auth.workspaceId,
          requestId,
          route: "/v1/billing/checkout",
          method: "POST",
          status: 200,
          effectivePlan: quota.effectivePlan,
          planStatus: auth.planStatus,
        },
        { txn_id: d.redact(txnId, "payu_txn_id"), provider: "payu" },
      );

      return jsonResponse(
        {
          provider: "payu",
          method: "POST",
          url: d.normalizePayUBaseUrl(env.PAYU_BASE_URL!),
          fields: checkoutFields,
        },
        200,
        rate.headers,
      );
    },

    async handleBillingPortal(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as BillingHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }
      return jsonResponse(
        {
          error: {
            code: "GONE",
            message: "Stripe billing portal has been removed. PayU billing is platform-only via checkout/webhooks.",
          },
          ...(requestId ? { request_id: requestId } : {}),
        },
        410,
        rate.headers,
      );
    },
  };
}
