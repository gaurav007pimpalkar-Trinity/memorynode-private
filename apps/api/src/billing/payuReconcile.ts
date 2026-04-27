/**
 * PayU checkout helpers, webhook signature checks, verify_payment reconciliation,
 * and workspace entitlement upserts. Extracted from workerApp for readability.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPlan } from "@memorynodeai/shared";
import type { AuthContext } from "../auth.js";
import { normalizePlanStatus } from "../auth.js";
import type { Env } from "../env.js";
import { createHttpError } from "../http.js";
import { logger, redact } from "../logger.js";
import { capsByPlanCode, type UsageSnapshot } from "../limits.js";
import {
  RETRY_MAX_ATTEMPTS,
  PAYU_VERIFY_RETRY_DELAYS_MS,
  PAYU_VERIFY_TIMEOUT_MS,
} from "../resilienceConstants.js";
import type { PayUWebhookPayload } from "./payuHash.js";
import { buildPayUResponseReverseHashInput, computeSha512Hex } from "./payuHash.js";
import {
  authPlanFromEntitlement,
  resolveEntitlementExpiry,
  resolveEntitlementPlanCode,
  type EffectivePlanCode,
} from "./entitlements.js";

export const DEFAULT_PAYU_CURRENCY = "INR";
export const DEFAULT_PAYU_PRODUCT_INFO = "MemoryNode Platform";
export const DEFAULT_PAYU_VERIFY_URL = "https://info.payu.in/merchant/postservice?form=2";
export const DEFAULT_WEBHOOK_REPROCESS_LIMIT = 50;

export function assertPayUEnvFor(path: string, env: Env): void {
  const missing: string[] = [];
  if (!env.PAYU_MERCHANT_KEY) missing.push("PAYU_MERCHANT_KEY");
  if (!env.PAYU_MERCHANT_SALT) missing.push("PAYU_MERCHANT_SALT");
  if (!env.PAYU_BASE_URL) missing.push("PAYU_BASE_URL");
  if (!env.PUBLIC_APP_URL) missing.push("PUBLIC_APP_URL");
  if (path === "/v1/billing/webhook" && !env.PAYU_VERIFY_URL) missing.push("PAYU_VERIFY_URL");
  if (missing.length) {
    throw createHttpError(500, "CONFIG_ERROR", `Missing PayU configuration: ${missing.join(", ")}`);
  }
}

export function isPayUBillingConfigured(env: Env): boolean {
  return Boolean(env.PAYU_MERCHANT_KEY && env.PAYU_MERCHANT_SALT && env.PAYU_BASE_URL && env.PUBLIC_APP_URL);
}

export function normalizePayUStatus(status: string | null | undefined): "success" | "pending" | "failure" | "canceled" {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "success") return "success";
  if (normalized === "pending") return "pending";
  if (normalized === "cancel" || normalized === "cancelled" || normalized === "canceled") return "canceled";
  return "failure";
}

export function planStatusFromPayUStatus(status: "success" | "pending" | "failure" | "canceled"): AuthContext["planStatus"] {
  if (status === "success") return "active";
  if (status === "pending") return "past_due";
  if (status === "canceled") return "canceled";
  return "past_due";
}

function normalizeMoneyString(raw: string | undefined, fallback = "999.00"): string {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed.toFixed(2);
}

function formatINRAmount(n: number): string {
  return Number.isFinite(n) ? Number(n).toFixed(2) : "0.00";
}

export function resolvePayUAmountForPlan(planCode: string, env: Env): string {
  const code = resolveEntitlementPlanCode(planCode);
  const fromEnv =
    code === "launch" ? env.PAYU_LAUNCH_AMOUNT
    : code === "build" ? env.PAYU_BUILD_AMOUNT
    : code === "deploy" ? env.PAYU_DEPLOY_AMOUNT
    : code === "scale" ? env.PAYU_SCALE_AMOUNT
    : env.PAYU_PRO_AMOUNT;
  if (fromEnv != null && fromEnv.trim() !== "") {
    const parsed = Number(fromEnv.trim());
    if (Number.isFinite(parsed) && parsed > 0) return formatINRAmount(parsed);
  }
  const plan = getPlan(code);
  return plan && plan.price_inr > 0
    ? formatINRAmount(plan.price_inr)
    : (env.PAYU_PRO_AMOUNT ? normalizeMoneyString(env.PAYU_PRO_AMOUNT, "999.00") : "999.00");
}

export function resolveProductInfoForPlan(planCode: string, env: Env): string {
  const code = resolveEntitlementPlanCode(planCode);
  const plan = getPlan(code);
  const base = (env.PAYU_PRODUCT_INFO ?? DEFAULT_PAYU_PRODUCT_INFO).trim() || DEFAULT_PAYU_PRODUCT_INFO;
  return plan ? `${base} — ${plan.label}` : base;
}

export function normalizeCurrency(raw: string | undefined): string {
  const normalized = (raw ?? DEFAULT_PAYU_CURRENCY).trim().toUpperCase();
  return normalized || DEFAULT_PAYU_CURRENCY;
}

export function paymentPeriodEndFromStatus(status: "success" | "pending" | "failure" | "canceled"): string | null {
  if (status !== "success") return null;
  const next = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return next.toISOString();
}

export function normalizePayUBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw createHttpError(500, "CONFIG_ERROR", "PAYU_BASE_URL not set");
  const parsed = new URL(trimmed);
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/_payment";
  }
  return parsed.toString();
}

function normalizePayUHash(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

export function asNonEmptyString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePayUEventCreated(raw: unknown): number {
  const direct = Number(raw);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  if (typeof raw === "string" && raw.trim().length > 0) {
    const ts = Date.parse(raw);
    if (Number.isFinite(ts) && ts > 0) return Math.floor(ts / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

export function parseWebhookPayload(raw: string, contentType: string): PayUWebhookPayload {
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      return (parsed ?? {}) as PayUWebhookPayload;
    } catch {
      throw createHttpError(400, "BAD_REQUEST", "Webhook body must be valid JSON");
    }
  }
  const params = new URLSearchParams(raw);
  const payload: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    payload[k] = v;
  }
  return payload as PayUWebhookPayload;
}

export async function isPayUWebhookSignatureValid(
  payload: PayUWebhookPayload,
  rawBody: string,
  request: Request,
  env: Env,
): Promise<boolean> {
  const received = normalizePayUHash(payload.hash);
  if (!received) return false;

  const merchantKey = asNonEmptyString(payload.key);
  if (merchantKey && merchantKey !== env.PAYU_MERCHANT_KEY) return false;

  const reverse = buildPayUResponseReverseHashInput(payload, env);
  const expected = normalizePayUHash(await computeSha512Hex(reverse));
  if (expected === received) return true;

  const additionalCharges = asNonEmptyString((payload as { additionalCharges?: unknown }).additionalCharges);
  if (additionalCharges) {
    const expectedWithCharges = normalizePayUHash(await computeSha512Hex(`${additionalCharges}|${reverse}`));
    if (expectedWithCharges === received) return true;
  }

  return false;
}

export type PayUTransactionStatus =
  | "created"
  | "initiated"
  | "verify_failed"
  | "verified"
  | "success"
  | "failed"
  | "canceled"
  | "pending";

export type PayUTransactionRow = {
  txn_id: string;
  workspace_id: string;
  plan_code: string;
  amount: number | string;
  currency: string;
  status: PayUTransactionStatus;
  payu_payment_id?: string | null;
};

export type PayUVerifyResponse = {
  ok: boolean;
  status: "success" | "pending" | "failure" | "canceled";
  statusRaw: string;
  txnId: string;
  paymentId: string | null;
  amount: string;
  currency: string;
  payload: Record<string, unknown>;
};

function normalizePayUTxnStatus(raw: string | null | undefined): PayUTransactionStatus {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "created") return "created";
  if (normalized === "initiated") return "initiated";
  if (normalized === "verify_failed") return "verify_failed";
  if (normalized === "verified") return "verified";
  if (normalized === "success") return "success";
  if (normalized === "failed") return "failed";
  if (normalized === "canceled") return "canceled";
  if (normalized === "pending") return "pending";
  return "created";
}

function payUTxnStatusRank(status: PayUTransactionStatus): number {
  switch (status) {
    case "created":
      return 10;
    case "initiated":
      return 20;
    case "verify_failed":
      return 30;
    case "pending":
      return 35;
    case "verified":
      return 40;
    case "success":
      return 50;
    case "failed":
      return 60;
    case "canceled":
      return 60;
    default:
      return 0;
  }
}

function canTransitionPayUTxnStatus(current: PayUTransactionStatus, next: PayUTransactionStatus): boolean {
  if (current === "success" && next !== "success") return false;
  if (current === "failed" && next !== "failed") return false;
  if (current === "canceled" && next !== "canceled") return false;
  return payUTxnStatusRank(next) >= payUTxnStatusRank(current);
}

function payUStatusFromTxnStatus(status: PayUTransactionStatus): "success" | "pending" | "failure" | "canceled" {
  if (status === "success" || status === "verified") return "success";
  if (status === "pending") return "pending";
  if (status === "canceled") return "canceled";
  return "failure";
}

export function formatAmountStrict(raw: unknown): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return "0.00";
  return value.toFixed(2);
}

function resolveCapsByEntitlementPlan(planCode: string): UsageSnapshot {
  return capsByPlanCode(resolveEntitlementPlanCode(planCode));
}

export async function fetchPayUTransactionByTxnId(
  supabase: SupabaseClient,
  txnId: string,
): Promise<PayUTransactionRow | null> {
  const row = await supabase
    .from("payu_transactions")
    .select("txn_id,workspace_id,plan_code,amount,currency,status,payu_payment_id")
    .eq("txn_id", txnId)
    .maybeSingle();
  if (row.error) {
    throw createHttpError(500, "DB_ERROR", row.error.message ?? "Failed to read PayU transaction");
  }
  return (row.data as PayUTransactionRow | null) ?? null;
}

export async function transitionPayUTransactionStatus(
  supabase: SupabaseClient,
  txnId: string,
  next: PayUTransactionStatus,
  fields: {
    paymentId?: string | null;
    verifyStatus?: string | null;
    verifyPayload?: Record<string, unknown> | null;
    lastError?: string | null;
    requestId?: string | null;
  } = {},
): Promise<PayUTransactionStatus> {
  const current = await supabase
    .from("payu_transactions")
    .select("status")
    .eq("txn_id", txnId)
    .maybeSingle();
  if (current.error) {
    throw createHttpError(500, "DB_ERROR", current.error.message ?? "Failed to read transaction status");
  }
  const currentStatus = normalizePayUTxnStatus((current.data as { status?: string } | null)?.status);
  if (!canTransitionPayUTxnStatus(currentStatus, next)) {
    return currentStatus;
  }
  const payload: Record<string, unknown> = {
    status: next,
    updated_at: new Date().toISOString(),
  };
  if (fields.paymentId !== undefined) payload.payu_payment_id = fields.paymentId;
  if (fields.verifyStatus !== undefined) payload.verify_status = fields.verifyStatus;
  if (fields.verifyPayload !== undefined) payload.verify_payload = fields.verifyPayload;
  if (fields.lastError !== undefined) payload.last_error = fields.lastError;
  if (fields.requestId !== undefined) payload.request_id = fields.requestId;
  if (fields.verifyStatus !== undefined || fields.verifyPayload !== undefined) {
    payload.verify_checked_at = new Date().toISOString();
  }

  const updated = await supabase.from("payu_transactions").update(payload).eq("txn_id", txnId);
  if (updated.error) {
    throw createHttpError(500, "DB_ERROR", updated.error.message ?? "Failed to update transaction state");
  }
  return next;
}

function resolvePayUVerifyUrl(env: Env): string {
  const raw = (env.PAYU_VERIFY_URL ?? DEFAULT_PAYU_VERIFY_URL).trim();
  if (!raw) throw createHttpError(500, "CONFIG_ERROR", "PAYU_VERIFY_URL not set");
  return raw;
}

export function resolvePayUVerifyTimeoutMs(env: Env): number {
  const parsed = Number(env.PAYU_VERIFY_TIMEOUT_MS ?? PAYU_VERIFY_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return PAYU_VERIFY_TIMEOUT_MS;
  return Math.min(30_000, Math.max(1_000, Math.floor(parsed)));
}

function parsePayUVerifyTransactionDetails(payload: Record<string, unknown>, txnId: string): Record<string, unknown> | null {
  const details = payload.transaction_details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const byTxn = (details as Record<string, unknown>)[txnId];
  if (!byTxn || typeof byTxn !== "object" || Array.isArray(byTxn)) return null;
  return byTxn as Record<string, unknown>;
}

async function verifyPayUTransactionViaApi(env: Env, txn: PayUTransactionRow): Promise<PayUVerifyResponse> {
  const command = "verify_payment";
  const var1 = txn.txn_id;
  const hashSeed = [env.PAYU_MERCHANT_KEY ?? "", command, var1, env.PAYU_MERCHANT_SALT ?? ""].join("|");
  const verifyHash = await computeSha512Hex(hashSeed);
  const body = new URLSearchParams({
    key: env.PAYU_MERCHANT_KEY ?? "",
    command,
    var1,
    hash: verifyHash,
  });

  const maxAttempts = RETRY_MAX_ATTEMPTS;
  const delaysMs = PAYU_VERIFY_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    if (attempt > 0) {
      logger.info({
        event: "payu_verify_retry",
        attempt,
        txn_id: txn.txn_id,
        max_attempts: maxAttempts + 1,
      });
      await new Promise((r) => setTimeout(r, delaysMs[attempt - 1] ?? 500));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), resolvePayUVerifyTimeoutMs(env));
    let response: Response;
    try {
      response = await fetch(resolvePayUVerifyUrl(env), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (attempt === maxAttempts) {
        const message = redact((err as Error)?.message, "message");
        throw createHttpError(502, "VERIFY_API_UNAVAILABLE", `PayU verify API unavailable: ${message}`);
      }
      continue;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      lastError = new Error(`HTTP ${response.status}`);
      if (attempt === maxAttempts) {
        throw createHttpError(502, "VERIFY_API_UNAVAILABLE", `PayU verify API failed with status ${response.status}`);
      }
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      throw createHttpError(502, "VERIFY_API_BAD_RESPONSE", "PayU verify API returned non-JSON payload");
    }

    const details = parsePayUVerifyTransactionDetails(payload, txn.txn_id);
    if (!details) {
      throw createHttpError(502, "VERIFY_API_BAD_RESPONSE", "PayU verify response missing transaction_details entry");
    }

    const verifyTxnId = asNonEmptyString(details.txnid) ?? txn.txn_id;
    const amount = formatAmountStrict(details.amount ?? details.amt ?? details.net_amount_debit);
    const currency = normalizeCurrency(asNonEmptyString(details.currency) ?? txn.currency);
    const paymentId =
      asNonEmptyString(details.mihpayid) ??
      asNonEmptyString(details.payuMoneyId) ??
      asNonEmptyString(details.payment_id) ??
      null;
    const statusRaw =
      asNonEmptyString(details.unmappedstatus) ??
      asNonEmptyString(details.status) ??
      asNonEmptyString(details.field9) ??
      "failure";
    const status = normalizePayUStatus(statusRaw);
    const approved = status === "success";
    return {
      ok: approved && verifyTxnId === txn.txn_id,
      status,
      statusRaw,
      txnId: verifyTxnId,
      paymentId,
      amount,
      currency,
      payload,
    };
  }
  throw lastError;
}

async function upsertWorkspaceEntitlementFromTransaction(
  supabase: SupabaseClient,
  txn: PayUTransactionRow,
  verify: PayUVerifyResponse,
): Promise<void> {
  const now = new Date();
  const startsAt = now.toISOString();
  const expiresAt = resolveEntitlementExpiry(resolveEntitlementPlanCode(txn.plan_code), now);
  const planCode = resolveEntitlementPlanCode(txn.plan_code);
  const caps = resolveCapsByEntitlementPlan(planCode);
  const existing = await supabase
    .from("workspace_entitlements")
    .select("id")
    .eq("source_txn_id", txn.txn_id)
    .maybeSingle();
  if (existing.error) {
    throw createHttpError(500, "DB_ERROR", existing.error.message ?? "Failed to read entitlement");
  }
  const payload = {
    workspace_id: txn.workspace_id,
    source_txn_id: txn.txn_id,
    plan_code: planCode,
    status: "active",
    starts_at: startsAt,
    expires_at: expiresAt,
    caps_json: caps,
    metadata: {
      payu_status: verify.status,
      payu_status_raw: verify.statusRaw,
      payu_payment_id: verify.paymentId,
      amount: verify.amount,
      currency: verify.currency,
    },
    updated_at: new Date().toISOString(),
  };
  if ((existing.data as { id?: number } | null)?.id) {
    const updated = await supabase
      .from("workspace_entitlements")
      .update(payload)
      .eq("id", (existing.data as { id: number }).id);
    if (updated.error) {
      throw createHttpError(500, "DB_ERROR", updated.error.message ?? "Failed to update entitlement");
    }
    return;
  }
  const inserted = await supabase.from("workspace_entitlements").insert(payload);
  if (inserted.error) {
    throw createHttpError(500, "DB_ERROR", inserted.error.message ?? "Failed to create entitlement");
  }

  try {
    const planRow = await supabase
      .from("plans")
      .select("id")
      .eq("plan_code", planCode)
      .maybeSingle();
    const planId = Number((planRow.data as { id?: number } | null)?.id ?? 0);
    if (planId > 0) {
      const existingV3 = await supabase
        .from("entitlements")
        .select("id")
        .eq("source_txn_id", txn.txn_id)
        .maybeSingle();
      const periodStart = startsAt;
      const periodEnd = expiresAt ?? new Date(Date.parse(startsAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
      const payloadV3 = {
        workspace_id: txn.workspace_id,
        plan_id: planId,
        status: "active",
        period_start: periodStart,
        period_end: periodEnd,
        auto_renew: true,
        source_txn_id: txn.txn_id,
        billing_provider: "payu",
        hard_cap_enabled: true,
        soft_cap_enabled: true,
        metadata: {
          payu_status: verify.status,
          payu_status_raw: verify.statusRaw,
          payu_payment_id: verify.paymentId,
          amount: verify.amount,
          currency: verify.currency,
          mirrored_from: "workspace_entitlements",
        },
        updated_at: new Date().toISOString(),
      };
      if ((existingV3.data as { id?: number } | null)?.id) {
        await supabase
          .from("entitlements")
          .update(payloadV3)
          .eq("id", Number((existingV3.data as { id: number }).id));
      } else {
        await supabase.from("entitlements").insert(payloadV3);
      }
    }
  } catch {
    /* schema may not be deployed everywhere */
  }
}

export function resolvePayUEventId(payload: PayUWebhookPayload): string {
  const paymentId = asNonEmptyString(payload.mihpayid);
  if (paymentId) return paymentId;
  const txnId = asNonEmptyString(payload.txnid) ?? "unknown_txn";
  const status = asNonEmptyString(payload.status) ?? "unknown_status";
  const created = resolvePayUEventCreated(payload);
  return `${txnId}:${status}:${created}`;
}

export function resolvePayUEventType(payload: PayUWebhookPayload): string {
  return `payment.${normalizePayUStatus(payload.status)}`;
}

export function resolvePayUEventCreated(payload: PayUWebhookPayload): number {
  const source = payload.addedon ?? (payload as { created?: unknown }).created;
  return parsePayUEventCreated(source);
}

type PayUWebhookEventRow = {
  event_id: string;
  status?: string | null;
  event_created?: number | null;
  processed_at?: string | null;
  workspace_id?: string | null;
  txn_id?: string | null;
  payment_id?: string | null;
  payu_status?: string | null;
  defer_reason?: string | null;
  request_id?: string | null;
  last_error?: string | null;
};

export type PayUReconcileWebhookResult = {
  outcome: "processed" | "replayed" | "ignored_stale" | "deferred";
  payuEventId: string;
  eventType: string;
  eventCreated: number;
  workspaceId?: string | null;
  txnId?: string | null;
  paymentId?: string | null;
  replayStatus?: string | null;
  deferReason?: string | null;
};

function shouldApplyPayUEvent(
  lastEventCreatedRaw: unknown,
  lastEventIdRaw: unknown,
  incomingEventCreated: number,
  incomingEventId: string,
): boolean {
  const lastEventCreated = Number(lastEventCreatedRaw);
  if (!Number.isFinite(lastEventCreated) || lastEventCreated <= 0) return true;
  if (incomingEventCreated > lastEventCreated) return true;
  if (incomingEventCreated < lastEventCreated) return false;
  const lastEventId = typeof lastEventIdRaw === "string" ? lastEventIdRaw : "";
  if (!lastEventId) return true;
  return incomingEventId.localeCompare(lastEventId) > 0;
}

async function markPayUWebhookEventProcessing(supabase: SupabaseClient, eventId: string): Promise<void> {
  const u = await supabase.from("payu_webhook_events").update({ status: "processing" }).eq("event_id", eventId);
  if (u.error) {
    throw createHttpError(500, "DB_ERROR", u.error.message ?? "Failed to mark webhook event processing");
  }
}

async function claimPayUWebhookEvent(
  supabase: SupabaseClient,
  eventId: string,
  eventType: string,
  eventCreated: number,
  payload: PayUWebhookPayload,
  requestId = "",
): Promise<{ replayed: boolean; replayStatus?: string | null }> {
  const txnId = asNonEmptyString(payload.txnid);
  if (!txnId) throw createHttpError(400, "BAD_REQUEST", "PayU payload missing txnid");
  const paymentId = asNonEmptyString(payload.mihpayid);
  const payuStatus = normalizePayUStatus(payload.status);

  const inserted = await supabase
    .from("payu_webhook_events")
    .insert({
      event_id: eventId,
      event_type: eventType,
      event_created: eventCreated,
      txn_id: txnId,
      payment_id: paymentId,
      payu_status: payuStatus,
      status: "received",
      request_id: requestId || null,
      payload,
      processed_at: null,
      last_error: null,
    })
    .select("event_id,status")
    .maybeSingle();
  if (!inserted.error) {
    await markPayUWebhookEventProcessing(supabase, eventId);
    return { replayed: false };
  }
  if (inserted.error.code !== "23505") {
    throw createHttpError(500, "DB_ERROR", inserted.error.message ?? "Failed to register webhook idempotency key");
  }

  const existing = await supabase
    .from("payu_webhook_events")
    .select("event_id,status")
    .eq("event_id", eventId)
    .maybeSingle();
  if (existing.error) {
    throw createHttpError(500, "DB_ERROR", existing.error.message ?? "Failed to read webhook idempotency row");
  }
  const existingStatus = ((existing.data as PayUWebhookEventRow | null)?.status ?? "processed").toLowerCase();
  if (existingStatus === "failed" || existingStatus === "deferred" || existingStatus === "received") {
    const retry = await supabase
      .from("payu_webhook_events")
      .update({
        status: "processing",
        request_id: requestId || null,
        event_type: eventType,
        event_created: eventCreated,
        txn_id: txnId,
        payment_id: paymentId,
        payu_status: payuStatus,
        payload,
        processed_at: null,
        last_error: null,
        defer_reason: null,
      })
      .eq("event_id", eventId);
    if (retry.error) {
      throw createHttpError(500, "DB_ERROR", retry.error.message ?? "Failed to reopen failed webhook event");
    }
    return { replayed: false };
  }
  return { replayed: true, replayStatus: existingStatus };
}

async function finalizePayUWebhookEvent(
  supabase: SupabaseClient,
  eventId: string,
  status: "processed" | "ignored_stale" | "deferred",
  fields: {
    workspaceId?: string | null;
    txnId?: string | null;
    paymentId?: string | null;
    payuStatus?: string | null;
    requestId?: string;
    deferReason?: string | null;
  },
): Promise<void> {
  const finalize = await supabase
    .from("payu_webhook_events")
    .update({
      status,
      processed_at: status === "deferred" ? null : new Date().toISOString(),
      workspace_id: fields.workspaceId ?? null,
      txn_id: fields.txnId ?? null,
      payment_id: fields.paymentId ?? null,
      payu_status: fields.payuStatus ?? null,
      request_id: fields.requestId || null,
      defer_reason: status === "deferred" ? fields.deferReason ?? "deferred" : null,
      last_error: status === "deferred" ? fields.deferReason ?? "Webhook deferred" : null,
    })
    .eq("event_id", eventId);
  if (finalize.error) {
    throw createHttpError(500, "DB_ERROR", finalize.error.message ?? "Failed to finalize webhook event");
  }
}

async function failPayUWebhookEvent(
  supabase: SupabaseClient,
  eventId: string,
  err: unknown,
  requestId = "",
): Promise<void> {
  const message = redact((err as Error)?.message, "message");
  const lastError = typeof message === "string" ? message : "Webhook processing failed";
  const fail = await supabase
    .from("payu_webhook_events")
    .update({
      status: "failed",
      last_error: lastError,
      processed_at: null,
      defer_reason: null,
    })
    .eq("event_id", eventId);
  if (fail.error) {
    logger.error({
      event: "webhook_event_mark_failed_error",
      payu_event_id: eventId,
      request_id: requestId || null,
      error_message: fail.error.message,
      err: fail.error,
    });
  } else {
    logger.error({
      event: "payu_webhook_event_failed",
      payu_event_id: eventId,
      request_id: requestId || null,
      last_error: lastError,
      err,
    });
  }
}

async function findWorkspaceForPayUEvent(
  supabase: SupabaseClient,
  workspaceHint: string | null,
  txnId: string | null,
): Promise<string | null> {
  if (workspaceHint) {
    const byHint = await supabase.from("workspaces").select("id").eq("id", workspaceHint).maybeSingle();
    if (byHint.data?.id) return byHint.data.id as string;
  }
  if (txnId) {
    const byTxn = await supabase.from("workspaces").select("id").eq("payu_txn_id", txnId).maybeSingle();
    if (byTxn.data?.id) return byTxn.data.id as string;
  }
  return null;
}

export type EmitProductEventForPayU = (
  supabase: SupabaseClient,
  eventName: string,
  ctx: {
    workspaceId?: string | null;
    requestId?: string;
    route?: string;
    method?: string;
    status?: number;
    effectivePlan?: EffectivePlanCode | AuthContext["plan"];
    planStatus?: AuthContext["planStatus"];
  },
  props?: Record<string, unknown>,
  ensureUnique?: boolean,
) => Promise<void>;

export function createPayUWebhookReconciler(ctx: { emitProductEvent: EmitProductEventForPayU }) {
  return async function reconcilePayUWebhook(
    payload: PayUWebhookPayload,
    supabase: SupabaseClient,
    env: Env,
    requestId = "",
    forcedEventId?: string,
  ): Promise<PayUReconcileWebhookResult> {
    const eventId = forcedEventId ?? resolvePayUEventId(payload);
    const eventType = resolvePayUEventType(payload);
    const eventCreated = resolvePayUEventCreated(payload);
    const claim = await claimPayUWebhookEvent(supabase, eventId, eventType, eventCreated, payload, requestId);
    if (claim.replayed) {
      return {
        outcome: "replayed",
        payuEventId: eventId,
        eventType,
        eventCreated,
        replayStatus: claim.replayStatus ?? null,
      };
    }

    const txnId = asNonEmptyString(payload.txnid);
    if (!txnId) throw createHttpError(400, "BAD_REQUEST", "PayU payload missing txnid");

    const txn = await fetchPayUTransactionByTxnId(supabase, txnId);
    let paymentId = asNonEmptyString(payload.mihpayid);
    let payuStatus = normalizePayUStatus(payload.status);
    let workspaceId = txn?.workspace_id ?? null;
    let deferReason: string | null = null;
    let outcome: "processed" | "ignored_stale" | "deferred" = "processed";

    try {
      if (!txn) {
        deferReason = "transaction_not_found";
        outcome = "deferred";
      } else {
        const verified = await verifyPayUTransactionViaApi(env, txn);
        payuStatus = verified.status;
        paymentId = verified.paymentId ?? paymentId;
        workspaceId = txn.workspace_id;

        const amountMatches = verified.amount === formatAmountStrict(txn.amount);
        const currencyMatches = normalizeCurrency(verified.currency) === normalizeCurrency(txn.currency);
        const txnMatches = verified.txnId === txn.txn_id;
        const verifiedSuccess = verified.ok && verified.status === "success" && amountMatches && currencyMatches && txnMatches;

        if (!verifiedSuccess) {
          const failureState: PayUTransactionStatus =
            verified.status === "pending"
              ? "pending"
              : verified.status === "canceled"
                ? "canceled"
                : "verify_failed";
          const txnState = await transitionPayUTransactionStatus(supabase, txn.txn_id, failureState, {
            paymentId,
            verifyStatus: verified.statusRaw,
            verifyPayload: verified.payload,
            lastError:
              txnMatches && amountMatches && currencyMatches ? "verify_status_not_success" : "verify_payload_mismatch",
            requestId: requestId || null,
          });
          payuStatus = payUStatusFromTxnStatus(txnState);
        } else {
          const verifiedState = await transitionPayUTransactionStatus(supabase, txn.txn_id, "verified", {
            paymentId,
            verifyStatus: verified.statusRaw,
            verifyPayload: verified.payload,
            lastError: null,
            requestId: requestId || null,
          });
          const successState = await transitionPayUTransactionStatus(supabase, txn.txn_id, "success", {
            paymentId,
            verifyStatus: verified.statusRaw,
            verifyPayload: verified.payload,
            lastError: null,
            requestId: requestId || null,
          });
          payuStatus = payUStatusFromTxnStatus(successState);
          if (verifiedState === "verified" && successState === "success") {
            await upsertWorkspaceEntitlementFromTransaction(supabase, txn, verified);
          }
        }

        const workspaceHint = workspaceId;
        workspaceId = await findWorkspaceForPayUEvent(supabase, workspaceHint, txnId);
        if (!workspaceId) {
          deferReason = "workspace_not_found";
          outcome = "deferred";
        } else {
          const currentRow = await supabase
            .from("workspaces")
            .select("plan_status,payu_last_event_created,payu_last_event_id")
            .eq("id", workspaceId)
            .maybeSingle();
          if (currentRow.error) {
            throw createHttpError(500, "DB_ERROR", currentRow.error.message ?? "Failed to read billing cursor");
          }
          const current = currentRow.data as
            | {
                plan_status?: string;
                payu_last_event_created?: number | null;
                payu_last_event_id?: string | null;
              }
            | null;
          const shouldApply = shouldApplyPayUEvent(
            current?.payu_last_event_created,
            current?.payu_last_event_id,
            eventCreated,
            eventId,
          );
          if (!shouldApply) {
            outcome = "ignored_stale";
          } else {
            const planCode = resolveEntitlementPlanCode(txn.plan_code);
            const effectivePlanCode = payuStatus === "success" ? authPlanFromEntitlement(planCode) : "launch";
            const planStatus = payuStatus === "success" ? "active" : planStatusFromPayUStatus(payuStatus);
            const oldStatus = normalizePlanStatus(current?.plan_status);
            const workspacePlanForDb: AuthContext["plan"] = "pro";
            const updatePayload = {
              billing_provider: "payu",
              payu_txn_id: txnId,
              payu_payment_id: paymentId,
              payu_last_status: payuStatus,
              payu_last_plan: workspacePlanForDb,
              payu_last_event_id: eventId,
              payu_last_event_created: eventCreated,
              plan: workspacePlanForDb,
              plan_status: planStatus,
              current_period_end: paymentPeriodEndFromStatus(payuStatus),
              cancel_at_period_end: false,
              updated_at: new Date().toISOString(),
            };
            const updated = await supabase.from("workspaces").update(updatePayload).eq("id", workspaceId);
            if (updated.error) {
              throw createHttpError(500, "DB_ERROR", updated.error.message ?? "Failed to update PayU billing state");
            }
            if ((planStatus === "active" || planStatus === "trialing") && !(oldStatus === "active" || oldStatus === "trialing")) {
              void ctx.emitProductEvent(supabase, "upgrade_activated", {
                workspaceId,
                requestId,
                route: "/v1/billing/webhook",
                method: "POST",
                status: 200,
                effectivePlan: effectivePlanCode,
                planStatus,
              });
            }
          }
        }
      }

      await finalizePayUWebhookEvent(supabase, eventId, outcome, {
        workspaceId,
        txnId,
        paymentId,
        payuStatus,
        requestId,
        deferReason,
      });
    } catch (err) {
      await failPayUWebhookEvent(supabase, eventId, err, requestId);
      if (err && typeof err === "object") {
        Object.assign(err as Record<string, unknown>, { payu_event_id: eventId, event_type: eventType });
      }
      throw err;
    }

    return {
      outcome,
      payuEventId: eventId,
      eventType,
      eventCreated,
      workspaceId,
      txnId,
      paymentId,
      deferReason,
    };
  }
}
