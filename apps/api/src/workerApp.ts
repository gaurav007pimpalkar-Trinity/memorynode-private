import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import {
  DEFAULT_TOPK,
  capsByPlanCode,
  exceedsCaps,
  MAX_QUERY_CHARS,
  MAX_TOPK,
  type UsageSnapshot,
} from "./limits.js";
import { getPlan, getLimitsForPlanCode, type PlanLimits } from "@memorynodeai/shared";
import type { Env } from "./env.js";
import { getEnvironmentStage, validateStubModes, validateRateLimitConfig, validateSecrets } from "./env.js";
import { logger, redact } from "./logger.js";
import { route, type HandlerDeps } from "./router.js";
import { createHttpError, isApiError } from "./http.js";
import { checkGlobalCostGuard, AIBudgetExceededError } from "./costGuard.js";
import {
  type RequestContext,
  buildResponseHeaders,
  buildSecurityHeaders,
  parseAllowedOrigins,
  isOriginAllowed,
  makeCorsHeaders,
  resolveRequestId,
  runInRequestScope,
} from "./cors.js";
import {
  rateLimit,
  rateLimitWorkspace,
  requireAdmin,
  type AuthContext,
  normalizePlanStatus,
  getApiKeySalt,
  hashApiKey,
} from "./auth.js";
import { emitAuditLog } from "./audit.js";
import {
  createMemoryHandlers,
  type MemoryHandlerDeps,
} from "./handlers/memories.js";
import {
  createSearchHandlers,
  type SearchHandlerDeps,
} from "./handlers/search.js";
import { createContextHandlers } from "./handlers/context.js";
import { createUsageHandlers, type UsageHandlerDeps } from "./handlers/usage.js";
import { createBillingHandlers, type BillingHandlerDeps } from "./handlers/billing.js";
import { createWebhookHandlers, type WebhookHandlerDeps } from "./handlers/webhooks.js";
import { createAdminHandlers, type AdminHandlerDeps } from "./handlers/admin.js";
import { createExportHandlers, type ExportHandlerDeps } from "./handlers/export.js";
import { createImportHandlers, type ImportHandlerDeps, type ImportMode } from "./handlers/import.js";
import { createWorkspacesHandlers, type WorkspacesHandlerDeps } from "./handlers/workspaces.js";
import { createApiKeysHandlers, type ApiKeysHandlerDeps } from "./handlers/apiKeys.js";
import { createEvalHandlers, type EvalHandlerDeps } from "./handlers/eval.js";
import { createEpisodeHandlers } from "./handlers/episodes.js";
import {
  createDashboardSession,
  deleteDashboardSession,
  getDashboardSession,
  validateDashboardCsrf,
  verifySupabaseAccessToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  SESSION_TTL_SEC,
} from "./dashboardSession.js";
import { withSupabaseQueryRetry } from "./supabaseRetry.js";
import {
  RETRY_MAX_ATTEMPTS,
  SUPABASE_RETRY_DELAYS_MS,
  OPENAI_EMBED_RETRY_DELAYS_MS,
  PAYU_VERIFY_RETRY_DELAYS_MS,
  EMBED_REQUEST_TIMEOUT_MS,
  PAYU_VERIFY_TIMEOUT_MS,
} from "./resilienceConstants.js";
import { withCircuitBreaker } from "./circuitBreaker.js";

type MetadataFilter = Record<string, string | number | boolean>;

interface SearchFilters {
  metadata?: MetadataFilter;
  start_time?: string;
  end_time?: string;
  memory_type?: string | string[];
  filter_mode?: "and" | "or";
}

type PayUWebhookPayload = {
  key?: string;
  txnid?: string;
  mihpayid?: string;
  status?: string;
  hash?: string;
  amount?: string;
  productinfo?: string;
  firstname?: string;
  email?: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  currency?: string;
  addedon?: string;
  [key: string]: unknown;
};

function parseApiKeyMeta(raw: string): { prefix: string; last4: string } {
  const parts = raw.split("_");
  if (parts.length >= 3) {
    return {
      prefix: parts.slice(0, 2).join("_"),
      last4: raw.slice(-4),
    };
  }
  return { prefix: "", last4: raw.slice(-4) };
}

interface SearchPayload {
  user_id: string;
  namespace?: string;
  query: string;
  top_k?: number;
  page?: number;
  page_size?: number;
  filters?: SearchFilters;
  explain?: boolean;
  search_mode?: "hybrid" | "vector" | "keyword";
  min_score?: number;
}

interface NormalizedSearchParams {
  user_id: string;
  namespace: string;
  query: string;
  top_k: number;
  page: number;
  page_size: number;
  explain?: boolean;
  search_mode: "hybrid" | "vector" | "keyword";
  min_score?: number;
  filters: {
    metadata?: MetadataFilter;
    start_time?: string;
    end_time?: string;
    memory_types?: string[];
    filter_mode: "and" | "or";
  };
}

interface MemoryListParams {
  page: number;
  page_size: number;
  namespace?: string;
  user_id?: string;
  memory_type?: string;
  filters: {
    metadata?: MetadataFilter;
    start_time?: string;
    end_time?: string;
  };
}

const DEFAULT_NAMESPACE = "default";
const SEARCH_MATCH_COUNT = 200;
const MAX_PAGE_SIZE = 50;
const MAX_FUSE_RESULTS = 200;
const DEFAULT_LIST_PAGE_SIZE = 20;
const DEFAULT_MAX_BODY_BYTES = 1_000_000; // 1 MB
const DEFAULT_MAX_IMPORT_BYTES = 10_000_000; // 10 MB
const DEFAULT_MAX_EXPORT_BYTES = 10_000_000; // 10 MB
const MEMORIES_MAX_BODY_BYTES = 1_000_000; // 1 MB for ingest
const SEARCH_MAX_BODY_BYTES = 200_000; // 200 KB for search/context
const ADMIN_MAX_BODY_BYTES = 100_000; // 100 KB for admin/control plane ops
const EXPORT_MAX_BODY_BYTES = 100_000; // exports carry no payload; keep tight
const RRF_K = 60;
const DEFAULT_SUCCESS_PATH = "/settings/billing?status=success";
const DEFAULT_CANCEL_PATH = "/settings/billing?status=canceled";
const DEFAULT_PAYU_CURRENCY = "INR";
const DEFAULT_PAYU_PRODUCT_INFO = "MemoryNode Platform";
const DEFAULT_PAYU_VERIFY_URL = "https://info.payu.in/merchant/postservice?form=2";
const DEFAULT_WEBHOOK_REPROCESS_LIMIT = 50;

const ENTITLEMENT_DURATION_DAYS: Record<string, number | null> = {
  launch: 7,
  build: 30,
  deploy: 30,
  scale: 30,
  scale_plus: null,
  pro: 30,
};

/** Effective plan surfaced in API responses (plan_code or "free"). Not internal DB plan (free/pro/team). */
export type EffectivePlanCode = "launch" | "build" | "deploy" | "scale" | "scale_plus" | "free";

type ProductEventContext = {
  workspaceId?: string | null;
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  effectivePlan?: EffectivePlanCode | AuthContext["plan"];
  planStatus?: AuthContext["planStatus"];
};

function emitEventLog(event_name: string, fields: Record<string, unknown>): void {
  logger.info({
    event: event_name,
    ...fields,
  });
}

async function emitProductEvent(
  supabase: SupabaseClient,
  eventName: string,
  ctx: ProductEventContext,
  props: Record<string, unknown> = {},
  ensureUnique = false,
): Promise<void> {
  try {
    if (!ctx.workspaceId) return;
    if (ensureUnique) {
      const existing = await supabase
        .from("product_events")
        .select("id")
        .eq("workspace_id", ctx.workspaceId)
        .eq("event_name", eventName)
        .limit(1)
        .maybeSingle();
      if (existing.data) return;
    }

    await supabase.from("product_events").insert({
      workspace_id: ctx.workspaceId,
      event_name: eventName,
      request_id: ctx.requestId ?? null,
      route: ctx.route ?? null,
      method: ctx.method ?? null,
      status: ctx.status ?? null,
      effective_plan: ctx.effectivePlan ?? null,
      plan_status: ctx.planStatus ?? null,
      props: props ?? {},
    });
  } catch (err) {
    logger.error({
      event: "product_event_emit_failed",
      event_target: eventName,
      message: redact((err as Error)?.message, "message"),
      err,
    });
  }
}

function effectivePlan(plan: AuthContext["plan"], status?: AuthContext["planStatus"]): AuthContext["plan"] {
  if (status === "active" || status === "trialing") return plan;
  return "free";
}

function assertPayUEnvFor(path: string, env: Env): void {
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

function isPayUBillingConfigured(env: Env): boolean {
  return Boolean(env.PAYU_MERCHANT_KEY && env.PAYU_MERCHANT_SALT && env.PAYU_BASE_URL && env.PUBLIC_APP_URL);
}

function normalizePayUStatus(status: string | null | undefined): "success" | "pending" | "failure" | "canceled" {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "success") return "success";
  if (normalized === "pending") return "pending";
  if (normalized === "cancel" || normalized === "cancelled" || normalized === "canceled") return "canceled";
  return "failure";
}

function planStatusFromPayUStatus(status: "success" | "pending" | "failure" | "canceled"): AuthContext["planStatus"] {
  if (status === "success") return "active";
  if (status === "pending") return "past_due";
  if (status === "canceled") return "canceled";
  return "past_due";
}

function normalizeMoneyString(raw: string | undefined, fallback = "499.00"): string {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed.toFixed(2);
}

/** Format INR amount as string with two decimals (PayU expects "499.00", never "499"). */
function formatINRAmount(n: number): string {
  return Number.isFinite(n) ? Number(n).toFixed(2) : "0.00";
}

function resolvePayUAmountForPlan(planCode: string, env: Env): string {
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
    : (env.PAYU_PRO_AMOUNT ? normalizeMoneyString(env.PAYU_PRO_AMOUNT, "499.00") : "499.00");
}

function resolveProductInfoForPlan(planCode: string, env: Env): string {
  const code = resolveEntitlementPlanCode(planCode);
  const plan = getPlan(code);
  const base = (env.PAYU_PRODUCT_INFO ?? DEFAULT_PAYU_PRODUCT_INFO).trim() || DEFAULT_PAYU_PRODUCT_INFO;
  return plan ? `${base} — ${plan.label}` : base;
}

function normalizeCurrency(raw: string | undefined): string {
  const normalized = (raw ?? DEFAULT_PAYU_CURRENCY).trim().toUpperCase();
  return normalized || DEFAULT_PAYU_CURRENCY;
}

function paymentPeriodEndFromStatus(status: "success" | "pending" | "failure" | "canceled"): string | null {
  if (status !== "success") return null;
  const next = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return next.toISOString();
}

function resolveEntitlementExpiry(planCode: string, now = new Date()): string | null {
  const durationDays = ENTITLEMENT_DURATION_DAYS[planCode] ?? 30;
  if (durationDays === null) return null;
  return new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
}

function resolveEntitlementPlanCode(raw: string | null | undefined): string {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (!normalized) return "pro";
  if (normalized === "launch") return "launch";
  if (normalized === "build") return "build";
  if (normalized === "deploy") return "deploy";
  if (normalized === "scale") return "scale";
  if (normalized === "scale+" || normalized === "scale_plus") return "scale_plus";
  if (normalized === "pro") return "pro";
  return "pro";
}

function normalizePayUBaseUrl(raw: string): string {
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

function asNonEmptyString(raw: unknown): string | null {
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

type PayURequestHashFields = {
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
};

function payURequestHashSequence(fields: PayURequestHashFields): string {
  return [
    fields.key,
    fields.txnid,
    fields.amount,
    fields.productinfo,
    fields.firstname,
    fields.email,
    fields.udf1 ?? "",
    fields.udf2 ?? "",
    fields.udf3 ?? "",
    fields.udf4 ?? "",
    fields.udf5 ?? "",
    "",
    "",
    "",
    "",
    "",
    fields.salt,
  ].join("|");
}

function payUHashReverseSequence(payload: PayUWebhookPayload, env: Pick<Env, "PAYU_MERCHANT_SALT" | "PAYU_MERCHANT_KEY">): string {
  return [
    env.PAYU_MERCHANT_SALT ?? "",
    payload.status ?? "",
    "",
    "",
    "",
    "",
    "",
    payload.udf5 ?? "",
    payload.udf4 ?? "",
    payload.udf3 ?? "",
    payload.udf2 ?? "",
    payload.udf1 ?? "",
    payload.email ?? "",
    payload.firstname ?? "",
    payload.productinfo ?? "",
    payload.amount ?? "",
    payload.txnid ?? "",
    env.PAYU_MERCHANT_KEY ?? "",
  ].join("|");
}

export function buildPayURequestHashInput(fields: PayURequestHashFields): string {
  return payURequestHashSequence(fields);
}

export function buildPayUResponseReverseHashInput(payload: PayUWebhookPayload, env: Pick<Env, "PAYU_MERCHANT_SALT" | "PAYU_MERCHANT_KEY">): string {
  return payUHashReverseSequence(payload, env);
}

export async function computeSha512Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-512", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseWebhookPayload(raw: string, contentType: string): PayUWebhookPayload {
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

async function isPayUWebhookSignatureValid(
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

  const webhookSecret = asNonEmptyString(env.PAYU_WEBHOOK_SECRET);
  const signatureHeader = asNonEmptyString(request.headers.get("x-payu-signature"));
  if (webhookSecret && signatureHeader) {
    const fallback = normalizePayUHash(await computeSha512Hex(`${rawBody}|${webhookSecret}`));
    return fallback === normalizePayUHash(signatureHeader);
  }

  return false;
}

type PayUTransactionStatus =
  | "created"
  | "initiated"
  | "verify_failed"
  | "verified"
  | "success"
  | "failed"
  | "canceled"
  | "pending";

type PayUTransactionRow = {
  txn_id: string;
  workspace_id: string;
  plan_code: string;
  amount: number | string;
  currency: string;
  status: PayUTransactionStatus;
  payu_payment_id?: string | null;
};

type PayUVerifyResponse = {
  ok: boolean;
  status: "success" | "pending" | "failure" | "canceled";
  statusRaw: string;
  txnId: string;
  paymentId: string | null;
  amount: string;
  currency: string;
  payload: Record<string, unknown>;
};

type QuotaResolution = {
  caps: UsageSnapshot;
  planLimits: PlanLimits;
  effectivePlan: EffectivePlanCode;
  planStatus: AuthContext["planStatus"];
  blocked: false;
} | {
  caps: UsageSnapshot;
  planLimits: PlanLimits;
  effectivePlan: EffectivePlanCode;
  planStatus: AuthContext["planStatus"];
  blocked: true;
  errorCode: "ENTITLEMENT_EXPIRED";
  message: string;
  expiredAt: string | null;
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

function formatAmountStrict(raw: unknown): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return "0.00";
  return value.toFixed(2);
}

/** Returns effective plan code for API responses (launch|build|deploy|scale|scale_plus|free). */
function authPlanFromEntitlement(planCode: string): EffectivePlanCode {
  const normalized = resolveEntitlementPlanCode(planCode);
  if (normalized === "launch" || normalized === "build" || normalized === "deploy" || normalized === "scale" || normalized === "scale_plus") {
    return normalized;
  }
  if (normalized === "pro") return "build"; // legacy
  return "free";
}

function normalizeUsageCaps(raw: unknown): UsageSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const writes = Number((raw as Record<string, unknown>).writes);
  const reads = Number((raw as Record<string, unknown>).reads);
  const embeds = Number((raw as Record<string, unknown>).embeds);
  if (![writes, reads, embeds].every((v) => Number.isFinite(v) && v >= 0)) return null;
  return {
    writes: Math.floor(writes),
    reads: Math.floor(reads),
    embeds: Math.floor(embeds),
  };
}

function resolveCapsByEntitlementPlan(planCode: string): UsageSnapshot {
  return capsByPlanCode(resolveEntitlementPlanCode(planCode));
}

async function resolveQuotaForWorkspace(
  auth: AuthContext,
  supabase: SupabaseClient,
): Promise<QuotaResolution> {
  const fallbackCaps = capsByPlanCode("free");
  const fallbackPlanLimits = getLimitsForPlanCode("free");
  const fallbackPlan: EffectivePlanCode = "free";
  const fallbackStatus = auth.planStatus ?? "free";
  const now = Date.now();
  try {
    const query = await supabase
      .from("workspace_entitlements")
      .select("plan_code,status,starts_at,expires_at,caps_json")
      .eq("workspace_id", auth.workspaceId)
      .order("created_at", { ascending: false })
      .limit(25);
    if (query.error) {
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: fallbackPlan,
        planStatus: fallbackStatus,
        blocked: false,
      };
    }
    const rows = (query.data ?? []) as Array<{
      plan_code?: string | null;
      status?: string | null;
      starts_at?: string | null;
      expires_at?: string | null;
      caps_json?: unknown;
    }>;
    if (rows.length === 0) {
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: fallbackPlan,
        planStatus: fallbackStatus,
        blocked: false,
      };
    }

    const active = rows.find((row) => {
      const status = (row.status ?? "").toLowerCase();
      if (status !== "active") return false;
      const startsAt = row.starts_at ? Date.parse(row.starts_at) : 0;
      if (Number.isFinite(startsAt) && startsAt > now) return false;
      const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Number.POSITIVE_INFINITY;
      return !Number.isFinite(expiresAt) || expiresAt > now;
    });
    if (active) {
      const planCode = resolveEntitlementPlanCode(active.plan_code);
      const caps = normalizeUsageCaps(active.caps_json) ?? resolveCapsByEntitlementPlan(planCode);
      return {
        caps,
        planLimits: getLimitsForPlanCode(planCode),
        effectivePlan: authPlanFromEntitlement(planCode),
        planStatus: "active",
        blocked: false,
      };
    }

    const expired = rows.find((row) => {
      const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Number.NaN;
      return Number.isFinite(expiresAt) && expiresAt <= now;
    });
    if (expired) {
      return {
        caps: fallbackCaps,
        planLimits: fallbackPlanLimits,
        effectivePlan: "free",
        planStatus: "canceled",
        blocked: true,
        errorCode: "ENTITLEMENT_EXPIRED",
        message: "Active entitlement expired. Renew to continue quota-consuming API calls.",
        expiredAt: expired.expires_at ?? null,
      };
    }
  } catch {
    // Best-effort compatibility with test stubs or pre-migration schemas.
  }
  return {
    caps: fallbackCaps,
    planLimits: fallbackPlanLimits,
    effectivePlan: fallbackPlan,
    planStatus: fallbackStatus,
    blocked: false,
  };
}

async function fetchPayUTransactionByTxnId(
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

async function transitionPayUTransactionStatus(
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

function resolvePayUVerifyTimeoutMs(env: Env): number {
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

async function verifyPayUTransactionViaApi(
  env: Env,
  txn: PayUTransactionRow,
): Promise<PayUVerifyResponse> {
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
}

function buildUpgradeUrl(env: Env): string {
  if (env.PUBLIC_APP_URL) {
    try {
      return new URL("/billing", env.PUBLIC_APP_URL).toString();
    } catch {
      /* ignore invalid URL */
    }
  }
  return "/billing";
}

async function sha256HexString(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function shortHash(value: string, length = 12): Promise<string> {
  const full = await sha256HexString(value);
  return full.slice(0, length);
}

function capExceededResponse(
  auth: AuthContext,
  caps: UsageSnapshot,
  usage: UsageSnapshot,
  rateHeaders: Record<string, string> | undefined,
  env: Env,
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
  effectivePlanOverride: EffectivePlanCode = "free",
  planStatusOverride: AuthContext["planStatus"] = auth.planStatus ?? "free",
  logCtx?: { requestId?: string; route?: string; method?: string },
): Response {
  emitEventLog("cap_exceeded", {
    route: logCtx?.route ?? "",
    method: logCtx?.method ?? "",
    status: 402,
    request_id: logCtx?.requestId ?? "",
    workspace_id_redacted: redact(auth.workspaceId, "workspace_id"),
    effective_plan: effectivePlanOverride,
    plan_status: planStatusOverride,
  });
  return jsonResponse(
    {
      error: {
        code: "CAP_EXCEEDED",
        message: "Daily usage limits exceeded",
        upgrade_required: true,
        effective_plan: effectivePlanOverride,
        limits: caps,
        usage,
        upgrade_url: buildUpgradeUrl(env),
      },
    },
    402,
    rateHeaders,
  );
}

/** Plan v2: 402 with PLAN_LIMIT_EXCEEDED and limit/used/cap for clarity. */
function planLimitExceededResponse(
  limit: string,
  used: number,
  cap: number,
  rateHeaders: Record<string, string> | undefined,
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
  env: Env,
): Response {
  return jsonResponse(
    {
      error: {
        code: "PLAN_LIMIT_EXCEEDED",
        limit,
        used,
        cap,
        message: `Plan limit exceeded: ${limit}`,
        upgrade_url: buildUpgradeUrl(env),
      },
    },
    402,
    rateHeaders,
  );
}

async function checkCapsAndMaybeRespond(
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response,
  auth: AuthContext,
  supabase: SupabaseClient,
  deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
  rateHeaders: Record<string, string> | undefined,
  env: Env,
  logCtx?: { requestId?: string; route?: string; method?: string },
): Promise<Response | null> {
  const quota = await resolveQuotaForWorkspace(auth, supabase);
  if (quota.blocked) {
    return jsonResponse(
      {
        error: {
          code: quota.errorCode,
          message: quota.message,
          upgrade_required: true,
          effective_plan: "free",
          upgrade_url: buildUpgradeUrl(env),
          expired_at: quota.expiredAt,
        },
      },
      402,
      rateHeaders,
    );
  }
  const today = todayUtc();
  const usage = await getUsage(supabase, auth.workspaceId, today);
  const caps = quota.caps;
  const tooMuch = exceedsCaps(caps, usage as UsageSnapshot, deltas);
  if (tooMuch) {
    void emitProductEvent(
      supabase,
      "cap_exceeded",
      {
        workspaceId: auth.workspaceId,
        requestId: logCtx?.requestId,
        route: logCtx?.route,
        method: logCtx?.method,
        status: 402,
        effectivePlan: quota.effectivePlan,
        planStatus: quota.planStatus,
      },
      {},
    );
    return capExceededResponse(
      auth,
      caps,
      usage as UsageSnapshot,
      rateHeaders,
      env,
      jsonResponse,
      quota.effectivePlan,
      quota.planStatus,
      logCtx,
    );
  }
  return null;
}

function attachRequestIdToErrorPayload(data: unknown, status: number, requestId: string): unknown {
  if (status < 400) return data;
  if (!requestId) return data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const payload = data as Record<string, unknown>;
  if (!("error" in payload)) return data;
  if (typeof payload.request_id === "string" && payload.request_id.length > 0) return data;
  return { ...payload, request_id: requestId };
}

function createResponseFns(ctx: RequestContext): {
  jsonResponse: (data: unknown, status?: number, extraHeaders?: Record<string, string>) => Response;
  emptyResponse: (status?: number) => Response;
} {
  const baseHeaders = buildResponseHeaders(ctx);
  return {
    jsonResponse: (data: unknown, status = 200, extraHeaders?: Record<string, string>) => {
      const body = attachRequestIdToErrorPayload(data, status, ctx.requestId);
      return new Response(JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...baseHeaders,
          ...(extraHeaders ?? {}),
        },
      });
    },
    emptyResponse: (status = 204) => new Response(null, { status, headers: baseHeaders }),
  };
}

/** Default deps when handlers are called directly (e.g. from tests) without going through route(). */
const simpleJsonResponse = (data: unknown, status = 200, extraHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(extraHeaders ?? {}) },
  });

type ErrorLogFields = {
  error_code?: string;
  error_message?: string;
};

async function extractErrorLogFields(response: Response | null): Promise<ErrorLogFields> {
  if (!response || response.status < 400) return {};
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return {};
  try {
    const payload = (await response.clone().json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    const code = typeof payload?.error?.code === "string" ? payload.error.code : undefined;
    const message = typeof payload?.error?.message === "string" ? payload.error.message : undefined;
    return {
      ...(code ? { error_code: code } : {}),
      ...(message ? { error_message: redact(message, "message") as string } : {}),
    };
  } catch {
    return {};
  }
}

function ensureRateLimitDo(env: Env): void {
  const ns = env.RATE_LIMIT_DO as unknown as { idFromName?: unknown; get?: unknown };
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") {
    throw createHttpError(
      500,
      "CONFIG_ERROR",
      "Missing Durable Object binding RATE_LIMIT_DO. Check wrangler.toml durable_objects binding name.",
    );
  }
}

function isProductionStage(env: Env): boolean {
  const stage = (env.ENVIRONMENT ?? env.NODE_ENV ?? "").trim().toLowerCase();
  return stage === "prod" || stage === "production" || stage === "staging";
}

function enforceRuntimeConfigGuards(env: Env): void {
  if (!isProductionStage(env)) return;
  const supabaseMode = (env.SUPABASE_MODE ?? "").trim().toLowerCase();
  if (supabaseMode === "stub") {
    throw createHttpError(500, "CONFIG_ERROR", "SUPABASE_MODE=stub is forbidden in production");
  }
  const embeddingsMode = (env.EMBEDDINGS_MODE ?? "openai").trim().toLowerCase();
  if (embeddingsMode === "stub") {
    throw createHttpError(500, "CONFIG_ERROR", "EMBEDDINGS_MODE=stub is forbidden in production");
  }
  const rateLimitMode = (env.RATE_LIMIT_MODE ?? "on").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(rateLimitMode)) {
    throw createHttpError(500, "CONFIG_ERROR", "RATE_LIMIT_MODE=off is forbidden in production");
  }
}

function resolveBodyLimit(method: string, path: string, env: Env): number {
  const base = Number(env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES);
  if (method === "POST" && path === "/v1/memories") return Math.min(base, MEMORIES_MAX_BODY_BYTES);
  if (method === "POST" && (path === "/v1/search" || path === "/v1/context"))
    return Math.min(base, SEARCH_MAX_BODY_BYTES);
  if (method === "POST" && path === "/v1/export")
    return Math.min(Number(env.MAX_EXPORT_BYTES ?? DEFAULT_MAX_EXPORT_BYTES), EXPORT_MAX_BODY_BYTES);
  if (method === "POST" && path === "/v1/import") return Number(env.MAX_IMPORT_BYTES ?? DEFAULT_MAX_IMPORT_BYTES);
  if (method === "POST" && (path === "/v1/workspaces" || path === "/v1/api-keys" || path === "/v1/api-keys/revoke"))
    return Math.min(base, ADMIN_MAX_BODY_BYTES);
  if (method === "POST" && (path === "/v1/eval/run" || path === "/v1/search/replay"))
    return Math.min(base, SEARCH_MAX_BODY_BYTES);
  return base;
}

/** Known paths and allowed methods (Phase 2: 405 for wrong method). Single source of truth per IMPROVEMENT_PLAN.md. */
const KNOWN_PATH_ALLOWED_METHODS: Array<{ test: (path: string) => boolean; allow: string }> = [
  { test: (p) => p === "/healthz", allow: "GET" },
  { test: (p) => p === "/ready" || p === "/ready/", allow: "GET" },
  { test: (p) => p === "/v1/health", allow: "GET" },
  { test: (p) => p === "/v1/memories", allow: "GET, POST" },
  { test: (p) => /^\/v1\/memories\/[^/]+$/.test(p), allow: "GET, DELETE" },
  { test: (p) => p === "/v1/search", allow: "POST" },
  { test: (p) => p === "/v1/context", allow: "POST" },
  { test: (p) => p === "/v1/usage/today", allow: "GET" },
  { test: (p) => p === "/v1/billing/status", allow: "GET" },
  { test: (p) => p === "/v1/billing/checkout", allow: "POST" },
  { test: (p) => p === "/v1/billing/portal", allow: "POST" },
  { test: (p) => p === "/v1/billing/webhook", allow: "POST" },
  { test: (p) => p === "/v1/workspaces", allow: "POST" },
  { test: (p) => p === "/v1/api-keys", allow: "GET, POST" },
  { test: (p) => p === "/v1/api-keys/revoke", allow: "POST" },
  { test: (p) => p === "/v1/export", allow: "POST" },
  { test: (p) => p === "/v1/import", allow: "POST" },
  { test: (p) => p === "/v1/admin/billing/health", allow: "GET" },
  { test: (p) => p === "/admin/webhooks/reprocess", allow: "POST" },
  { test: (p) => p === "/admin/sessions/cleanup", allow: "POST" },
  { test: (p) => p === "/admin/memory-hygiene", allow: "POST" },
  { test: (p) => p === "/v1/dashboard/session", allow: "POST" },
  { test: (p) => p === "/v1/dashboard/logout", allow: "POST" },
  { test: (p) => p === "/v1/search/history", allow: "GET" },
  { test: (p) => p === "/v1/search/replay", allow: "POST" },
  { test: (p) => p === "/v1/eval/sets", allow: "GET, POST" },
  { test: (p) => /^\/v1\/eval\/sets\/[^/]+\/items$/.test(p), allow: "POST" },
  { test: (p) => p === "/v1/eval/run", allow: "POST" },
  { test: (p) => p === "/v1/episodes", allow: "GET, POST" },
];

/** If path is known but method is not allowed, returns Allow header value; otherwise null (use 404). */
function getMethodNotAllowedForKnownPath(pathname: string, method: string): string | null {
  const upper = method.toUpperCase();
  for (const { test, allow } of KNOWN_PATH_ALLOWED_METHODS) {
    if (!test(pathname)) continue;
    const allowed = allow.split(",").map((m) => m.trim());
    if (allowed.includes(upper)) return null;
    return allow;
  }
  return null;
}

export function handleRequest(request: Request, env: Env): Promise<Response> {
  return runInRequestScope(() => handleRequestImpl(request, env));
}

async function handleRequestImpl(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, "") || "/";
    const requestId = resolveRequestId(request);
    const allowlist = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const origin = request.headers.get("origin") ?? "";
    const ctx: RequestContext = {
      requestId,
      securityHeaders: buildSecurityHeaders(pathname),
      corsHeaders: makeCorsHeaders(origin, allowlist, request.headers),
    };
    const { jsonResponse, emptyResponse } = createResponseFns(ctx);

    function logHealthReadyCompleted(status: number): void {
      const durationMs = Date.now() - started;
      logger.info({
        event: "request_completed",
        request_id: requestId,
        workspace_id: null,
        route: pathname,
        route_group: "health",
        method: request.method,
        status,
        status_code: status,
        latency_ms: durationMs,
        duration_ms: durationMs,
      });
    }

    // GET /healthz: return version, build_version, stage, embedding_model; 500 if critical env missing in non-dev
    if (pathname === "/healthz") {
      if (request.method !== "GET") {
        logHealthReadyCompleted(405);
        return new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }), {
          status: 405,
          headers: { "content-type": "application/json", Allow: "GET", ...buildResponseHeaders(ctx) },
        });
      }
      const stage = getEnvironmentStage(env);
      if (stage !== "dev") {
        const missing: string[] = [];
        if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
        if (!env.API_KEY_SALT) missing.push("API_KEY_SALT");
        if (missing.length > 0) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({
              status: "error",
              error: { code: "CONFIG_ERROR", message: `Missing critical env: ${missing.join(", ")}` },
            }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
        const stubError = validateStubModes(env, stage);
        if (stubError) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({ status: "error", error: { code: "CONFIG_ERROR", message: stubError } }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
        const rateLimitError = validateRateLimitConfig(env, stage);
        if (rateLimitError) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({ status: "error", error: { code: "CONFIG_ERROR", message: rateLimitError } }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
        const secretsError = validateSecrets(env, stage);
        if (secretsError) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({ status: "error", error: { code: "CONFIG_ERROR", message: secretsError } }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
      }
      const buildVersion = (env.BUILD_VERSION ?? "").trim();
      const version = buildVersion || "dev";
      const stageStr = (env.ENVIRONMENT ?? env.NODE_ENV ?? "").trim();
      const embeddingsMode = (env.EMBEDDINGS_MODE ?? "openai").toLowerCase();
      const embeddingModel = embeddingsMode === "stub" ? "stub" : "text-embedding-3-small";
      logHealthReadyCompleted(200);
      return new Response(
        JSON.stringify({
          status: "ok",
          version,
          build_version: version,
          ...(stageStr ? { stage: stageStr } : {}),
          ...((env.GIT_SHA ?? "").trim() ? { git_sha: (env.GIT_SHA ?? "").trim() } : {}),
          embedding_model: embeddingModel,
        }),
        { status: 200, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
      );
    }

    // GET /ready: check Supabase connectivity; 503 if unavailable
    if (pathname === "/ready") {
      if (request.method !== "GET") {
        logHealthReadyCompleted(405);
        return new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }), {
          status: 405,
          headers: { "content-type": "application/json", Allow: "GET", ...buildResponseHeaders(ctx) },
        });
      }
      let supabaseForReady: SupabaseClient;
      try {
        supabaseForReady = createSupabaseClient(env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logHealthReadyCompleted(503);
        return new Response(
          JSON.stringify({ status: "degraded", db: "unavailable", message: msg }),
          { status: 503, headers: { "content-type": "application/json", "Cache-Control": "no-store", ...buildResponseHeaders(ctx) } },
        );
      }
      try {
        await withCircuitBreaker("supabase", async () => {
          const r = await withSupabaseQueryRetry(
            async () => {
              const result = await supabaseForReady.from("app_settings").select("id").limit(1).maybeSingle();
              return { data: result.data, error: result.error };
            },
            { delaysMs: SUPABASE_RETRY_DELAYS_MS },
          );
          if (r.error) throw r.error;
          return r;
        }, env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("CIRCUIT_OPEN:")) {
          logHealthReadyCompleted(503);
          return new Response(
            JSON.stringify({ status: "degraded", db: "unavailable", message: "Service temporarily unavailable" }),
            { status: 503, headers: { "content-type": "application/json", "Cache-Control": "no-store", ...buildResponseHeaders(ctx) } },
          );
        }
        const errMsg = e instanceof Error ? e.message : String(e);
        logHealthReadyCompleted(503);
        return new Response(
          JSON.stringify({ status: "degraded", db: "unavailable", message: errMsg }),
          { status: 503, headers: { "content-type": "application/json", "Cache-Control": "no-store", ...buildResponseHeaders(ctx) } },
        );
      }
      logHealthReadyCompleted(200);
      return new Response(JSON.stringify({ status: "ok", db: "connected" }), {
        status: 200,
        headers: { "content-type": "application/json", "Cache-Control": "no-store", ...buildResponseHeaders(ctx) },
      });
    }

    // GET /v1/health: versioned health (same payload as /healthz, no auth)
    if (pathname === "/v1/health" && request.method === "GET") {
      const stage = getEnvironmentStage(env);
      if (stage !== "dev") {
        const missing: string[] = [];
        if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
        if (!env.API_KEY_SALT) missing.push("API_KEY_SALT");
        if (missing.length > 0) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({
              status: "error",
              error: { code: "CONFIG_ERROR", message: `Missing critical env: ${missing.join(", ")}` },
            }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
        const secretsError = validateSecrets(env, stage);
        if (secretsError) {
          logHealthReadyCompleted(500);
          return new Response(
            JSON.stringify({ status: "error", error: { code: "CONFIG_ERROR", message: secretsError } }),
            { status: 500, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
          );
        }
      }
      const buildVersion = (env.BUILD_VERSION ?? "").trim();
      const version = buildVersion || "dev";
      const stageStr = (env.ENVIRONMENT ?? env.NODE_ENV ?? "").trim();
      const embeddingsMode = (env.EMBEDDINGS_MODE ?? "openai").toLowerCase();
      const embeddingModel = embeddingsMode === "stub" ? "stub" : "text-embedding-3-small";
      logHealthReadyCompleted(200);
      return new Response(
        JSON.stringify({
          status: "ok",
          version,
          build_version: version,
          ...(stageStr ? { stage: stageStr } : {}),
          ...((env.GIT_SHA ?? "").trim() ? { git_sha: (env.GIT_SHA ?? "").trim() } : {}),
          embedding_model: embeddingModel,
        }),
        { status: 200, headers: { "content-type": "application/json", ...buildResponseHeaders(ctx) } },
      );
    }

    const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown";
    const originAllowed = isOriginAllowed(origin, allowlist);
    let supabase: SupabaseClient | null = null;
    const auditCtx: { workspaceId?: string; apiKeyId?: string } = {};
    let response: Response | null = null;
    try {
      if (allowlist && !originAllowed) {
        response = jsonResponse({ error: { code: "CORS_DENY", message: "Origin not allowed" } }, 403);
        return response;
      }

      enforceRuntimeConfigGuards(env);
      ensureRateLimitDo(env);

      if (request.method === "OPTIONS") {
        response = emptyResponse();
        return response;
      }

      const bodyLimit = resolveBodyLimit(request.method, url.pathname, env);
      await assertBodySize(request, env, bodyLimit);

      // 405 for known path + wrong method (before creating Supabase so no CONFIG_ERROR for wrong-method-only requests)
      const earlyAllow = getMethodNotAllowedForKnownPath(url.pathname, request.method);
      if (earlyAllow !== null) {
        response = jsonResponse(
          { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed for this resource" } },
          405,
          { Allow: earlyAllow },
        );
        return response;
      }

      // Production/staging: dashboard routes require ALLOWED_ORIGINS before creating Supabase
      if (url.pathname.startsWith("/v1/dashboard") && isProductionStage(env)) {
        const dashboardAllowlist = parseAllowedOrigins(env.ALLOWED_ORIGINS);
        if (!dashboardAllowlist || dashboardAllowlist.length === 0) {
          response = jsonResponse(
            {
              error: {
                code: "CONFIG_ERROR",
                message: "ALLOWED_ORIGINS must be set in production for dashboard access",
              },
            },
            503,
          );
          return response;
        }
      }

      supabase = createSupabaseClient(env);

      // Dashboard session (Phase 0.2): create session from Supabase token, or logout
      if (request.method === "POST" && url.pathname === "/v1/dashboard/session") {
        let body: { access_token?: string; workspace_id?: string };
        try {
          body = (await request.json()) as { access_token?: string; workspace_id?: string };
        } catch {
          response = jsonResponse({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }, 400);
          return response;
        }
        const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
        const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
        if (!accessToken || !workspaceId) {
          response = jsonResponse(
            { error: { code: "BAD_REQUEST", message: "access_token and workspace_id are required" } },
            400,
          );
          return response;
        }
        const verified = await verifySupabaseAccessToken(accessToken, env);
        if (!verified) {
          response = jsonResponse({ error: { code: "UNAUTHORIZED", message: "Invalid or expired Supabase token" } }, 401);
          return response;
        }
        const { data: member } = await supabase
          .from("workspace_members")
          .select("workspace_id")
          .eq("workspace_id", workspaceId)
          .eq("user_id", verified.userId)
          .maybeSingle();
        if (!member) {
          response = jsonResponse(
            { error: { code: "PERMISSION_DENIED", message: "Not a member of this workspace" } },
            403,
          );
          return response;
        }
        const { sessionId, csrfToken } = await createDashboardSession(supabase, verified.userId, workspaceId, SESSION_TTL_SEC);
        const isSecure = url.protocol === "https:";
        const cookieHeader = sessionCookieHeader(sessionId, SESSION_TTL_SEC, isSecure);
        response = new Response(JSON.stringify({ ok: true, csrf_token: csrfToken }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "Set-Cookie": cookieHeader,
            ...buildResponseHeaders(ctx),
          },
        });
        return response;
      }

      if (request.method === "POST" && url.pathname === "/v1/dashboard/logout") {
        const dashSession = await getDashboardSession(request, supabase);
        if (dashSession) {
          try {
            validateDashboardCsrf(request, dashSession, parseAllowedOrigins(env.ALLOWED_ORIGINS));
          } catch {
            response = jsonResponse(
              { error: { code: "PERMISSION_DENIED", message: "Invalid or missing CSRF token" } },
              403,
            );
            return response;
          }
          await deleteDashboardSession(supabase, dashSession.sessionId);
        }
        const isSecure = url.protocol === "https:";
        response = new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "Set-Cookie": clearSessionCookieHeader(isSecure),
            ...buildResponseHeaders(ctx),
          },
        });
        return response;
      }

      const handlerDeps: HandlerDeps & MemoryHandlerDeps & SearchHandlerDeps & UsageHandlerDeps & BillingHandlerDeps & WebhookHandlerDeps & AdminHandlerDeps & ExportHandlerDeps & ImportHandlerDeps & WorkspacesHandlerDeps & ApiKeysHandlerDeps & EvalHandlerDeps = {
        jsonResponse,
        safeParseJson,
        chunkText,
        embedText,
        todayUtc,
        vectorToPgvectorString,
        emitProductEvent,
        bumpUsage,
        effectivePlan,
        normalizeMemoryListParams,
        performListMemories,
        deleteMemoryCascade,
        checkCapsAndMaybeRespond,
        performSearch,
        getUsage,
        resolveQuotaForWorkspace,
        reserveQuotaAndMaybeRespond,
        planLimitExceededResponse,
        estimateEmbedTokens,
        normalizePlanStatus,
        emitEventLog,
        redact,
        isPayUBillingConfigured,
        assertPayUEnvFor,
        shortHash,
        fetchPayUTransactionByTxnId,
        formatAmountStrict,
        normalizeCurrency,
        transitionPayUTransactionStatus: transitionPayUTransactionStatus as BillingHandlerDeps["transitionPayUTransactionStatus"],
        buildPayURequestHashInput,
        computeSha512Hex,
        normalizePayUBaseUrl,
        resolveEntitlementPlanCode,
        getAmountForPlan: resolvePayUAmountForPlan,
        getProductInfoForPlan: resolveProductInfoForPlan,
        defaultSuccessPath: DEFAULT_SUCCESS_PATH,
        defaultCancelPath: DEFAULT_CANCEL_PATH,
        defaultProductInfo: DEFAULT_PAYU_PRODUCT_INFO,
        resolveBillingWebhooksEnabled,
        parseWebhookPayload: parseWebhookPayload as WebhookHandlerDeps["parseWebhookPayload"],
        asNonEmptyString,
        isPayUWebhookSignatureValid: isPayUWebhookSignatureValid as WebhookHandlerDeps["isPayUWebhookSignatureValid"],
        resolvePayUEventId: resolvePayUEventId as WebhookHandlerDeps["resolvePayUEventId"],
        resolvePayUEventType: resolvePayUEventType as WebhookHandlerDeps["resolvePayUEventType"],
        resolvePayUEventCreated: resolvePayUEventCreated as WebhookHandlerDeps["resolvePayUEventCreated"],
        reconcilePayUWebhook: reconcilePayUWebhook as WebhookHandlerDeps["reconcilePayUWebhook"],
        logger: logger as unknown as WebhookHandlerDeps["logger"],
        isApiError,
        requireAdmin,
        rateLimit,
        rateLimitWorkspace,
        defaultWebhookReprocessLimit: DEFAULT_WEBHOOK_REPROCESS_LIMIT,
        resolvePayUVerifyTimeoutMs,
        wantsZipResponse,
        buildExportArtifact: buildExportArtifact as ExportHandlerDeps["buildExportArtifact"],
        makeExportResponse: (outcome, wantsZip, auth, rateHeaders) =>
          makeExportResponse(outcome, wantsZip, auth, rateHeaders, buildResponseHeaders(ctx)),
        defaultMaxExportBytes: DEFAULT_MAX_EXPORT_BYTES,
        importArtifact: importArtifact as ImportHandlerDeps["importArtifact"],
        defaultMaxImportBytes: DEFAULT_MAX_IMPORT_BYTES,
        generateApiKey,
        getApiKeySalt,
        hashApiKey,
        setStubApiKeyIfPresent,
      };
      const memoryHandlers = createMemoryHandlers(handlerDeps, defaultMemoryHandlerDeps);
      const searchHandlers = createSearchHandlers(handlerDeps, defaultSearchHandlerDeps);
      const contextHandlers = createContextHandlers(handlerDeps, defaultSearchHandlerDeps);
      const usageHandlers = createUsageHandlers(handlerDeps, defaultUsageHandlerDeps);
      const billingHandlers = createBillingHandlers(handlerDeps, defaultBillingHandlerDeps);
      const webhookHandlers = createWebhookHandlers(handlerDeps, defaultWebhookHandlerDeps);
      const adminHandlers = createAdminHandlers(handlerDeps, defaultAdminHandlerDeps);
      const exportHandlers = createExportHandlers(handlerDeps, defaultExportHandlerDeps);
      const importHandlers = createImportHandlers(handlerDeps, defaultImportHandlerDeps);
      const workspacesHandlers = createWorkspacesHandlers(handlerDeps, defaultWorkspacesHandlerDeps);
      const apiKeysHandlers = createApiKeysHandlers(handlerDeps, defaultApiKeysHandlerDeps);
      const evalHandlers = createEvalHandlers(handlerDeps, defaultEvalHandlerDeps);
      const episodeHandlers = createEpisodeHandlers(handlerDeps, defaultEpisodeHandlerDeps);
      const routed = await route(request, env, supabase, url, auditCtx, requestId, {
        handlers: {
          ...memoryHandlers,
          ...searchHandlers,
          ...contextHandlers,
          ...usageHandlers,
          ...billingHandlers,
          ...webhookHandlers,
          ...adminHandlers,
          ...exportHandlers,
          ...importHandlers,
          ...workspacesHandlers,
          ...apiKeysHandlers,
          ...evalHandlers,
          ...episodeHandlers,
        },
        handlerDeps,
      });
      if (routed !== null) {
        response = routed;
        return response;
      }
      response = jsonResponse({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      return response;
    } catch (error: unknown) {
      const status = isApiError(error) ? error.status ?? 500 : 500;
      const errorCode = isApiError(error) ? error.code : "INTERNAL";
      const safeMessage = redact((error as Error)?.message, "message");
      logger.error({
        event: "request_failed",
        request_id: requestId,
        route: url.pathname,
        method: request.method,
        status,
        error_code: errorCode,
        error_message: safeMessage,
        workspace_id: auditCtx.workspaceId ?? null,
        err: error,
      });
      if (isApiError(error)) {
        response = jsonResponse(
          { error: { code: error.code, message: error.message } },
          error.status ?? 500,
          error.headers,
        );
        return response;
      }
      response = jsonResponse(
        { error: { code: "INTERNAL", message: "Unexpected error occurred" } },
        500,
      );
      return response;
    } finally {
        try {
          await emitAuditLog(request, response, started, ip, env, supabase, auditCtx, requestId);
          const durationMs = Date.now() - started;
          const errorFields = await extractErrorLogFields(response);
          logger.info({
            event: "request_completed",
            request_id: requestId,
            workspace_id: auditCtx.workspaceId ?? null,
            route: url.pathname,
            route_group: classifyRouteGroup(url.pathname),
            method: request.method,
            status: response?.status ?? 0,
            status_code: response?.status ?? 0,
            latency_ms: durationMs,
            duration_ms: durationMs,
            ...(errorFields.error_code ? { error_type: errorFields.error_code } : {}),
            ...errorFields,
          });
        } catch (_) {
          /* Logging best-effort; avoid masking original error */
        }
      }
}

export { createSupabaseClient };

/** Classify a URL pathname into a route group for golden-metrics aggregation. */
function classifyRouteGroup(pathname: string): string {
  if (pathname === "/healthz" || pathname === "/ready" || pathname === "/ready/") return "health";
  if (pathname === "/v1/health") return "health";
  if (pathname === "/v1/memories" || /^\/v1\/memories\/[^/]+$/.test(pathname)) return "memories";
  if (pathname === "/v1/search" || pathname === "/v1/search/history" || pathname === "/v1/search/replay") return "search";
  if (pathname === "/v1/context") return "context";
  if (pathname === "/v1/usage/today") return "usage";
  if (pathname.startsWith("/v1/billing/")) return "billing";
  if (pathname === "/v1/workspaces") return "workspaces";
  if (pathname.startsWith("/v1/api-keys")) return "api_keys";
  if (pathname === "/v1/export") return "export";
  if (pathname === "/v1/import") return "import";
  if (pathname.startsWith("/v1/admin/") || pathname.startsWith("/admin/")) return "admin";
  return "unknown";
}

function createSupabaseClient(env: Env): SupabaseClient {
  const supabaseMode = (env.SUPABASE_MODE ?? "").toLowerCase();
  if (supabaseMode === "stub") {
    if (isProductionStage(env)) {
      throw createHttpError(500, "CONFIG_ERROR", "SUPABASE_MODE=stub is forbidden in production");
    }
    return createStubSupabase(env) as unknown as SupabaseClient;
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw createHttpError(500, "CONFIG_ERROR", "Supabase env vars not set");
  }

  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

type StubRow = Record<string, unknown>;
type StubFilter = { col: string; val: unknown; op: "eq" | "in" | "contains" | "gte" | "lte" | "lt" };

let stubState: {
  db: {
    workspaces: StubRow[];
    api_keys: StubRow[];
    memories: StubRow[];
    memory_chunks: StubRow[];
    usage_daily: StubRow[];
    api_audit_log: StubRow[];
    app_settings: StubRow[];
    product_events: StubRow[];
    payu_webhook_events: StubRow[];
    payu_transactions: StubRow[];
    dashboard_sessions: StubRow[];
    agent_episodes: StubRow[];
  };
  rawApiKeys: Map<string, { workspaceId: string }>;
} | null = null;

function createStubSupabase(env: Env) {
  if (!stubState) {
    stubState = {
      db: {
        workspaces: [] as StubRow[],
        api_keys: [] as StubRow[],
        memories: [] as StubRow[],
        memory_chunks: [] as StubRow[],
        usage_daily: [] as StubRow[],
        api_audit_log: [] as StubRow[],
        app_settings: [{ api_key_salt: env.API_KEY_SALT ?? "" }],
        product_events: [] as StubRow[],
        payu_webhook_events: [] as StubRow[],
        payu_transactions: [] as StubRow[],
        dashboard_sessions: [] as StubRow[],
        agent_episodes: [] as StubRow[],
      },
      rawApiKeys: new Map<string, { workspaceId: string }>(),
    };
  }
  const { db, rawApiKeys } = stubState;

  const applyFilters = (rows: StubRow[], filters: StubFilter[]) =>
    rows.filter((r) =>
      filters.every((f) => {
        if (f.op === "contains") {
          const target = r[f.col] as Record<string, unknown>;
          return (
            typeof target === "object" &&
            target !== null &&
            Object.entries(f.val as Record<string, unknown>).every(([k, v]) => target[k] === v)
          );
        }
        if (f.op === "in") {
          const values = Array.isArray(f.val) ? f.val : [];
          return values.includes(r[f.col]);
        }
        if (f.op === "gte") return (r[f.col] as string) >= (f.val as string);
        if (f.op === "lte") return (r[f.col] as string) <= (f.val as string);
        if (f.op === "lt") return (r[f.col] as string) < (f.val as string);
        return r[f.col] === f.val;
      }),
    );

  const makeResult = (rows: StubRow[], count?: number) => ({
    data: rows,
    error: null,
    count,
    limit() {
      return this;
    },
    eq(col: string, val: unknown) {
      return makeResult(
        rows.filter((r) => r[col] === val),
        count ? rows.filter((r) => r[col] === val).length : undefined,
      );
    },
    is(col: string, val: unknown) {
      return this.eq(col, val);
    },
    gte(col: string, val: unknown) {
      return makeResult(
        rows.filter((r) => (r[col] as string) >= (val as string)),
        count ? rows.filter((r) => (r[col] as string) >= (val as string)).length : undefined,
      );
    },
    lte(col: string, val: unknown) {
      return makeResult(
        rows.filter((r) => (r[col] as string) <= (val as string)),
        count ? rows.filter((r) => (r[col] as string) <= (val as string)).length : undefined,
      );
    },
    contains(obj: Record<string, unknown>) {
      const filtered = rows.filter((r) => {
        const target = r.metadata as Record<string, unknown>;
        return typeof target === "object" && target !== null && Object.entries(obj).every(([k, v]) => target[k] === v);
      });
      return makeResult(filtered, count ? filtered.length : undefined);
    },
    order() {
      return this;
    },
    range() {
      return this;
    },
    maybeSingle() {
      return { data: rows[0] ?? null, error: null };
    },
    single() {
      return { data: rows[0] ?? null, error: null };
    },
    then<T>(onfulfilled?: (value: { data: StubRow[]; error: null }) => T | PromiseLike<T>, onrejected?: (reason: unknown) => never) {
      return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
    },
  });

  const tableBuilder = (table: keyof typeof db, filters: StubFilter[] = []) => ({
    eq(col: string, val: unknown) {
      filters.push({ col, val, op: "eq" });
      return tableBuilder(table, filters);
    },
    in(col: string, vals: unknown[]) {
      filters.push({ col, val: [...vals], op: "in" });
      return tableBuilder(table, filters);
    },
    contains(obj: Record<string, unknown>) {
      filters.push({ col: "metadata", val: obj, op: "contains" });
      return tableBuilder(table, filters);
    },
    gte(col: string, val: unknown) {
      filters.push({ col, val, op: "gte" });
      return tableBuilder(table, filters);
    },
    lte(col: string, val: unknown) {
      filters.push({ col, val, op: "lte" });
      return tableBuilder(table, filters);
    },
    select(_cols?: string, opts?: { count?: "exact" }) {
      const rows = applyFilters(db[table], filters);
      return makeResult(rows, opts?.count ? rows.length : undefined);
    },
    limit(_n: number) {
      void _n;
      return this;
    },
    insert(payload: StubRow | StubRow[]) {
      const rows = Array.isArray(payload) ? payload : [payload];
      rows.forEach((r) => {
        if (table === "api_keys" && !Object.prototype.hasOwnProperty.call(r, "revoked_at")) {
          (r as Record<string, unknown>).revoked_at = null;
        }
        if (!r.id) (r as Record<string, unknown>).id = crypto.randomUUID();
        if (!Object.prototype.hasOwnProperty.call(r, "created_at"))
          (r as Record<string, unknown>).created_at = new Date().toISOString();
        db[table].push(structuredClone(r));
      });
      return {
        select(_sel?: string) {
          void _sel;
          return {
            single: async () => ({ data: rows[0], error: null }),
            maybeSingle: async () => ({ data: rows[0], error: null }),
          };
        },
        single: async () => ({ data: rows[0], error: null }),
        maybeSingle: async () => ({ data: rows[0], error: null }),
        error: null,
        data: rows,
      };
    },
    update(values: Record<string, unknown>) {
      return {
        eq(col: string, val: unknown) {
          const withEq = filters.concat({ col, val, op: "eq" });
          return {
            in(col2: string, vals: unknown[]) {
              const withIn = withEq.concat({ col: col2, val: vals, op: "in" });
              const rows = applyFilters(db[table], withIn);
              rows.forEach((r) => Object.assign(r, values));
              return { data: rows, error: null };
            },
            then<TResult1 = unknown, TResult2 = never>(
              onfulfilled?: ((value: { data: StubRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) {
              const rows = applyFilters(db[table], withEq);
              rows.forEach((r) => Object.assign(r, values));
              return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
            },
          };
        },
      };
    },
    delete(opts?: { count?: "exact" }) {
      const deleteFilters = [...filters];
      let executed = false;
      let result: { data: StubRow[]; error: null; count: number | null } = {
        data: [],
        error: null,
        count: null,
      };
      const runDelete = () => {
        if (executed) return result;
        const rows = applyFilters(db[table as keyof typeof db] ?? [], deleteFilters);
        const remaining = (db[table as keyof typeof db] ?? []).filter((r) => !rows.includes(r));
        if (table in db) (db as Record<string, StubRow[]>)[table] = remaining;
        executed = true;
        const deletedData = rows.map((r) => ({ id: (r as { id?: unknown }).id ?? null }));
        result = { data: deletedData, error: null, count: opts?.count ? rows.length : null };
        return result;
      };
      const chain = {
        eq(col: string, val: unknown) {
          deleteFilters.push({ col, val, op: "eq" });
          return chain;
        },
        lt(col: string, val: unknown) {
          deleteFilters.push({ col, val, op: "lt" });
          return chain;
        },
        in(col: string, vals: unknown[]) {
          deleteFilters.push({ col, val: [...vals], op: "in" });
          return chain;
        },
        select(): Promise<{ data: StubRow[]; error: null }> {
          const out = runDelete();
          return Promise.resolve({ data: out.data, error: null });
        },
        then<TResult1 = typeof result, TResult2 = never>(
          onfulfilled?: ((value: typeof result) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(runDelete()).then(onfulfilled, onrejected);
        },
      };
      return chain;
    },
    order() {
      return this;
    },
    range(from?: number, to?: number) {
      if (from !== undefined && to !== undefined) {
        const rows = applyFilters(db[table], filters).slice(from, to + 1);
        return makeResult(rows);
      }
      return this;
    },
  });

  return {
    from(table: string) {
      return tableBuilder(table as keyof typeof db);
    },
    rpc(name: string, params: Record<string, unknown>) {
      switch (name) {
        case "bump_usage":
        case "bump_usage_rpc": {
          const existing = db.usage_daily.find(
            (r) => r.workspace_id === params.p_workspace_id && r.day === params.p_day,
          );
          if (existing) {
            existing.writes = (existing.writes as number) + (params.p_writes as number);
            existing.reads = (existing.reads as number) + (params.p_reads as number);
            existing.embeds = (existing.embeds as number) + (params.p_embeds as number);
            return Promise.resolve({ data: existing, error: null });
          }
          const row: Record<string, unknown> = {
            workspace_id: params.p_workspace_id,
            day: params.p_day,
            writes: params.p_writes,
            reads: params.p_reads,
            embeds: params.p_embeds,
            extraction_calls: 0,
            embed_tokens_used: 0,
          };
          db.usage_daily.push(row as StubRow);
          return Promise.resolve({ data: row, error: null });
        }
        case "bump_usage_if_within_cap": {
          const pW = (params.p_writes as number) ?? 0;
          const pR = (params.p_reads as number) ?? 0;
          const pE = (params.p_embeds as number) ?? 0;
          const pEt = (params.p_embed_tokens as number) ?? 0;
          const pEx = (params.p_extraction_calls as number) ?? 0;
          const capW = (params.p_writes_cap as number) ?? 0;
          const capR = (params.p_reads_cap as number) ?? 0;
          const capE = (params.p_embeds_cap as number) ?? 0;
          const capEt = (params.p_embed_tokens_cap as number) ?? 0;
          const capEx = (params.p_extraction_calls_cap as number) ?? 0;
          let existing = db.usage_daily.find(
            (r) => r.workspace_id === params.p_workspace_id && r.day === params.p_day,
          ) as Record<string, unknown> | undefined;
          if (!existing) {
            existing = {
              workspace_id: params.p_workspace_id,
              day: params.p_day,
              writes: 0,
              reads: 0,
              embeds: 0,
              extraction_calls: 0,
              embed_tokens_used: 0,
            };
            db.usage_daily.push(existing as StubRow);
          }
          const w = (existing.writes as number) ?? 0;
          const r = (existing.reads as number) ?? 0;
          const e = (existing.embeds as number) ?? 0;
          const et = (existing.embed_tokens_used as number) ?? 0;
          const ex = (existing.extraction_calls as number) ?? 0;
          if (w + pW > capW) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "writes" }], error: null });
          if (r + pR > capR) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "reads" }], error: null });
          if (e + pE > capE) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "embeds" }], error: null });
          if (et + pEt > capEt) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "embed_tokens" }], error: null });
          if (ex + pEx > capEx) return Promise.resolve({ data: [{ ...existing, exceeded: true, limit_name: "extraction_calls" }], error: null });
          existing.writes = w + pW;
          existing.reads = r + pR;
          existing.embeds = e + pE;
          existing.embed_tokens_used = et + pEt;
          existing.extraction_calls = ex + pEx;
          return Promise.resolve({ data: [{ ...existing, exceeded: false, limit_name: null }], error: null });
        }
        case "match_chunks_vector":
        case "match_chunks_text": {
          const memoryTypes = params.p_memory_types as string[] | null;
          const filterMode = (params.p_filter_mode as string) ?? "and";
          const metaFilter = params.p_metadata as Record<string, unknown> | null;

          let chunks = db.memory_chunks.filter(
            (c) =>
              c.workspace_id === params.p_workspace_id &&
              c.user_id === params.p_user_id &&
              c.namespace === params.p_namespace,
          );

          if (memoryTypes && memoryTypes.length > 0) {
            const memoryIdSet = new Set(
              db.memories
                .filter((m) =>
                  m.workspace_id === params.p_workspace_id &&
                  m.duplicate_of == null &&
                  typeof m.memory_type === "string" &&
                  memoryTypes.includes(m.memory_type as string),
                )
                .map((m) => m.id),
            );
            chunks = chunks.filter((c) => memoryIdSet.has(c.memory_id));
          } else {
            const nonDupIds = new Set(
              db.memories
                .filter((m) => m.workspace_id === params.p_workspace_id && m.duplicate_of == null)
                .map((m) => m.id),
            );
            chunks = chunks.filter((c) => nonDupIds.has(c.memory_id));
          }

          if (metaFilter && Object.keys(metaFilter).length > 0) {
            const matchingMemoryIds = new Set(
              db.memories
                .filter((m) => {
                  if (m.workspace_id !== params.p_workspace_id) return false;
                  const meta = (m.metadata ?? {}) as Record<string, unknown>;
                  const entries = Object.entries(metaFilter);
                  return filterMode === "or"
                    ? entries.some(([k, v]) => meta[k] === v)
                    : entries.every(([k, v]) => meta[k] === v);
                })
                .map((m) => m.id),
            );
            chunks = chunks.filter((c) => matchingMemoryIds.has(c.memory_id));
          }

          const q = (params.p_query as string | undefined)?.toLowerCase() ?? "";
          const results = chunks
            .filter((c) => (c.chunk_text as string).toLowerCase().includes(q))
            .slice(0, Number(params.p_match_count ?? 20))
            .map((c, idx) => ({
              chunk_id: c.id as string,
              memory_id: c.memory_id as string,
              chunk_index: c.chunk_index as number,
              chunk_text: c.chunk_text as string,
              score: 1 / (idx + 1),
            }));
          return Promise.resolve({ data: results, error: null });
        }
        default:
          return Promise.resolve({ data: null, error: null });
      }
    },
    __rawApiKeys: rawApiKeys,
    __db: db,
  };
}

async function safeParseJson<T>(request: Request): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = (await request.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parseIsoTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw createHttpError(400, "BAD_REQUEST", "Invalid ISO timestamp for time filter");
  }
  return parsed.toISOString();
}

function cleanMetadataFilter(raw?: Record<string, unknown> | MetadataFilter): MetadataFilter | undefined {
  if (!raw) return undefined;
  const cleaned: MetadataFilter = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === null || typeof val === "undefined") continue;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      cleaned[key] = val;
    } else {
      throw createHttpError(400, "BAD_REQUEST", "Metadata filter values must be primitives");
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function normalizeSearchPayload(payload: SearchPayload): NormalizedSearchParams {
  const { user_id, query } = payload;
  if (!user_id || !query) {
    throw createHttpError(400, "BAD_REQUEST", "user_id and query are required");
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw createHttpError(400, "BAD_REQUEST", `query exceeds ${MAX_QUERY_CHARS} chars`);
  }

  const namespace = (payload.namespace ?? DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;
  const top_k = clamp(payload.top_k ?? DEFAULT_TOPK, 1, MAX_TOPK);
  const page = clamp(payload.page ?? 1, 1, Number.MAX_SAFE_INTEGER);
  const page_size = clamp(payload.page_size ?? top_k, 1, MAX_PAGE_SIZE);

  const metadata = cleanMetadataFilter(payload.filters?.metadata);
  const start_time = parseIsoTimestamp(payload.filters?.start_time);
  const end_time = parseIsoTimestamp(payload.filters?.end_time);
  if (start_time && end_time && new Date(start_time) > new Date(end_time)) {
    throw createHttpError(400, "BAD_REQUEST", "start_time must be before or equal to end_time");
  }

  const rawMemoryType = payload.filters?.memory_type;
  const memory_types: string[] | undefined = rawMemoryType
    ? (Array.isArray(rawMemoryType) ? rawMemoryType : [rawMemoryType])
    : undefined;

  const filter_mode = payload.filters?.filter_mode ?? "and";
  const search_mode = payload.search_mode ?? "hybrid";
  const min_score = payload.min_score != null && payload.min_score >= 0 && payload.min_score <= 1
    ? payload.min_score
    : undefined;

  return {
    user_id,
    query,
    namespace,
    top_k,
    page,
    page_size,
    explain: payload.explain === true,
    search_mode,
    min_score,
    filters: {
      metadata,
      start_time,
      end_time,
      memory_types,
      filter_mode,
    },
  };
}

export function normalizeMemoryListParams(url: URL): MemoryListParams {
  const page = clamp(Number(url.searchParams.get("page") ?? 1), 1, Number.MAX_SAFE_INTEGER);
  const page_size = clamp(
    Number(url.searchParams.get("page_size") ?? DEFAULT_LIST_PAGE_SIZE),
    1,
    MAX_PAGE_SIZE,
  );
  const namespace = url.searchParams.get("namespace") ?? undefined;
  const user_id = url.searchParams.get("user_id") ?? undefined;

  let metadata: MetadataFilter | undefined;
  const metadataRaw = url.searchParams.get("metadata");
  if (metadataRaw) {
    try {
      const parsed = JSON.parse(decodeURIComponent(metadataRaw)) as Record<string, unknown>;
      metadata = cleanMetadataFilter(parsed);
    } catch {
      throw createHttpError(400, "BAD_REQUEST", "metadata must be valid JSON object");
    }
  }

  const start_time = parseIsoTimestamp(url.searchParams.get("start_time") ?? undefined);
  const end_time = parseIsoTimestamp(url.searchParams.get("end_time") ?? undefined);
  if (start_time && end_time && new Date(start_time) > new Date(end_time)) {
    throw createHttpError(400, "BAD_REQUEST", "start_time must be before or equal to end_time");
  }

  const memory_type = url.searchParams.get("memory_type")?.trim() || undefined;
  if (memory_type && !["fact", "preference", "event", "note"].includes(memory_type)) {
    throw createHttpError(400, "BAD_REQUEST", "memory_type must be one of: fact, preference, event, note");
  }

  return {
    page,
    page_size,
    namespace: namespace || undefined,
    user_id: user_id || undefined,
    memory_type,
    filters: { metadata, start_time, end_time },
  };
}

export { parseAllowedOrigins, isOriginAllowed, makeCorsHeaders } from "./cors.js";

export async function assertBodySize(request: Request, env: Env, overrideLimit?: number): Promise<void> {
  const limit = overrideLimit ?? Number(env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES);
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > limit) {
    throw createHttpError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
  }
  if (request.body) {
    const clone = request.clone();
    const reader = clone.body!.getReader();
    let received = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.length ?? 0;
      if (received > limit) {
        throw createHttpError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
      }
    }
  }
}

export { emitAuditLog } from "./audit.js";

function b64encode(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  const btoaFn = (globalThis as { btoa?: typeof btoa }).btoa as typeof btoa;
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoaFn(binary);
}

function b64decode(input: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(input, "base64"));
  }
  const atobFn = (globalThis as { atob?: typeof atob }).atob as typeof atob;
  const binary = atobFn(input);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type ExportManifest = {
  version: 1;
  workspace_id: string;
  generated_at: string;
  files: Array<{ name: string; sha256: string; size: number }>;
  counts: { memories: number; chunks: number };
};

export async function buildExportArtifact(
  auth: AuthContext,
  supabase: SupabaseClient,
  maxBytes = DEFAULT_MAX_EXPORT_BYTES,
): Promise<ExportOutcome> {
  const memRes = await supabase
    .from("memories")
    .select("id, user_id, namespace, text, metadata, created_at", { count: "exact" })
    .eq("workspace_id", auth.workspaceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (memRes.error) throw createHttpError(500, "DB_ERROR", memRes.error.message ?? "Failed to export memories");

  const chunkRes = await supabase
    .from("memory_chunks")
    .select("id, memory_id, user_id, namespace, chunk_index, chunk_text, embedding, created_at", { count: "exact" })
    .eq("workspace_id", auth.workspaceId)
    .order("memory_id")
    .order("chunk_index");
  if (chunkRes.error)
    throw createHttpError(500, "DB_ERROR", chunkRes.error.message ?? "Failed to export memory chunks");

  const memories = memRes.data ?? [];
  const chunks = chunkRes.data ?? [];

  const memNdjson = memories.map((m) => JSON.stringify(m)).join("\n");
  const chunkNdjson = chunks.map((c) => JSON.stringify(c)).join("\n");

  const files: Array<{ name: string; sha256: string; size: number; content: Uint8Array }> = [];
  const memBytes = new TextEncoder().encode(memNdjson);
  files.push({ name: "memories.ndjson", size: memBytes.length, content: memBytes, sha256: await sha256HexBytes(memBytes) });
  const chunkBytes = new TextEncoder().encode(chunkNdjson);
  files.push({
    name: "chunks.ndjson",
    size: chunkBytes.length,
    content: chunkBytes,
    sha256: await sha256HexBytes(chunkBytes),
  });

  const manifest: ExportManifest = {
    version: 1,
    workspace_id: auth.workspaceId,
    generated_at: new Date(0).toISOString(),
    counts: { memories: memories.length, chunks: chunks.length },
    files: files.map((f) => ({ name: f.name, sha256: f.sha256, size: f.size })).sort((a, b) => a.name.localeCompare(b.name)),
  };

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  files.push({ name: "manifest.json", size: manifestBytes.length, content: manifestBytes, sha256: await sha256HexBytes(manifestBytes) });

  const zip = new JSZip();
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    zip.file(f.name, f.content, { date: new Date(0) });
  }
  const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
  if (archive.length > maxBytes) {
    throw createHttpError(413, "payload_too_large", `export exceeds ${maxBytes} bytes`);
  }
  const sha = await sha256HexBytes(archive);
  return { artifact_base64: b64encode(archive), bytes: archive.length, sha256: sha, archive };
}

export function wantsZipResponse(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.searchParams.get("format")?.toLowerCase() === "zip" ||
    (request.headers.get("accept") ?? "").toLowerCase().includes("application/zip")
  );
}

export async function importArtifact(
  auth: AuthContext,
  supabase: SupabaseClient,
  artifactBase64: string,
  maxBytes: number,
  mode: ImportMode = "upsert",
  options?: {
    preInsertGuard?: (deltas: {
      writesDelta: number;
      readsDelta: number;
      embedsDelta: number;
      embedTokensDelta: number;
      extractionCallsDelta: number;
    }) => Promise<Response | null>;
  },
): Promise<ImportOutcome | { cap_exceeded: true; response: Response }> {
  const allowedModes: ImportMode[] = ["upsert", "skip_existing", "error_on_conflict", "replace_ids", "replace_all"];
  if (!allowedModes.includes(mode)) {
    throw createHttpError(400, "BAD_REQUEST", "invalid import mode");
  }

  const zipBytes = b64decode(artifactBase64);
  if (zipBytes.length > maxBytes) {
    throw createHttpError(413, "payload_too_large", `artifact exceeds ${maxBytes} bytes`);
  }
  const zip = await JSZip.loadAsync(zipBytes);
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw createHttpError(400, "BAD_REQUEST", "manifest.json missing");
  const manifestText = await manifestEntry.async("string");
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(manifestText) as ExportManifest;
  } catch {
    throw createHttpError(400, "BAD_REQUEST", "manifest.json invalid");
  }
  if (manifest.workspace_id !== auth.workspaceId) {
    throw createHttpError(403, "FORBIDDEN", "Artifact workspace mismatch");
  }
  if (manifest.version !== 1) throw createHttpError(400, "BAD_REQUEST", "Unsupported manifest version");

  const readFileChecked = async (name: string) => {
    const entry = zip.file(name);
    if (!entry) throw createHttpError(400, "BAD_REQUEST", `${name} missing`);
    const bytes = new Uint8Array(await entry.async("uint8array"));
    const sha = await sha256HexBytes(bytes);
    const declared = manifest.files.find((f) => f.name === name);
    if (!declared || declared.sha256 !== sha) {
      throw createHttpError(400, "BAD_REQUEST", `${name} checksum mismatch`);
    }
    return bytes;
  };

  const memBytes = await readFileChecked("memories.ndjson");
  const chunkBytes = await readFileChecked("chunks.ndjson");

  const parseNdjson = (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes).trim() === ""
      ? []
      : new TextDecoder()
          .decode(bytes)
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));

  const memories = parseNdjson(memBytes).map((m) => ({ ...m, workspace_id: auth.workspaceId }));
  const chunks = parseNdjson(chunkBytes).map((c) => ({ ...c, workspace_id: auth.workspaceId }));

  const memIds = memories.map((m) => m.id);
  const chunkIds = chunks.map((c) => c.id);

  const fetchExistingIds = async (table: "memories" | "memory_chunks", ids: string[]): Promise<Set<string>> => {
    if (!ids.length) return new Set<string>();
    const { data, error } = await supabase
      .from(table)
      .select("id", { count: "exact" })
      .eq("workspace_id", auth.workspaceId)
      .in("id", ids);
    if (error) {
      throw createHttpError(500, "DB_ERROR", error.message ?? `Failed to check existing ${table}`);
    }
    return new Set((data ?? []).map((r: { id: string }) => r.id));
  };

  const ensureOk = (result: { error: { message?: string } | null }, fallback: string) => {
    if (result.error) throw createHttpError(500, "DB_ERROR", result.error.message ?? fallback);
  };

  let memoriesToWrite = memories;
  let chunksToWrite = chunks;

  if (mode === "error_on_conflict") {
    const existingMemIds = await fetchExistingIds("memories", memIds);
    const existingChunkIds = await fetchExistingIds("memory_chunks", chunkIds);
    if (existingMemIds.size > 0 || existingChunkIds.size > 0) {
      throw createHttpError(409, "CONFLICT", "Import conflicts with existing ids");
    }
  }

  if (mode === "skip_existing") {
    const existingMemIds = await fetchExistingIds("memories", memIds);
    memoriesToWrite = memories.filter((m) => !existingMemIds.has(m.id));
    const allowedMemoryIds = new Set(memoriesToWrite.map((m) => m.id));
    const existingChunkIds = await fetchExistingIds("memory_chunks", chunkIds);
    chunksToWrite = chunks.filter((c) => !existingChunkIds.has(c.id) && allowedMemoryIds.has(c.memory_id));
  }

  if (mode === "replace_all") {
    const delChunks = await supabase.from("memory_chunks").delete().eq("workspace_id", auth.workspaceId);
    ensureOk(delChunks, "Failed to clear chunks");
    const delMems = await supabase.from("memories").delete().eq("workspace_id", auth.workspaceId);
    ensureOk(delMems, "Failed to clear memories");
  }

  if (mode === "replace_ids") {
    if (memories.length > 0) {
      const delChunks = await supabase.from("memory_chunks").delete().eq("workspace_id", auth.workspaceId).in("memory_id", memIds);
      ensureOk(delChunks, "Failed to delete chunks by id");
      const delMems = await supabase.from("memories").delete().eq("workspace_id", auth.workspaceId).in("id", memIds);
      ensureOk(delMems, "Failed to delete memories by id");
    }
  }

  const writesDelta = memoriesToWrite.length;
  const embedsDelta = chunksToWrite.length;
  const embedTokensDelta = chunksToWrite.reduce(
    (sum, c) => sum + estimateEmbedTokens(String((c as { chunk_text?: string }).chunk_text ?? "").length),
    0,
  );
  if (options?.preInsertGuard) {
    const guardResponse = await options.preInsertGuard({
      writesDelta,
      readsDelta: 0,
      embedsDelta,
      embedTokensDelta,
      extractionCallsDelta: 0,
    });
    if (guardResponse) return { cap_exceeded: true, response: guardResponse };
  }

  let importedMemories = 0;
  let importedChunks = 0;

  if (memoriesToWrite.length > 0) {
    if (mode === "upsert") {
      const res = await supabase.from("memories").upsert(memoriesToWrite, { onConflict: "id" });
      ensureOk(res, "Failed to import memories");
    } else {
      const res = await supabase.from("memories").insert(memoriesToWrite);
      ensureOk(res, "Failed to import memories");
    }
    importedMemories = memoriesToWrite.length;
  }

  if (chunksToWrite.length > 0) {
    if (mode === "upsert") {
      const res = await supabase.from("memory_chunks").upsert(chunksToWrite, { onConflict: "id" });
      ensureOk(res, "Failed to import chunks");
    } else {
      const res = await supabase.from("memory_chunks").insert(chunksToWrite);
      ensureOk(res, "Failed to import chunks");
    }
    importedChunks = chunksToWrite.length;
  }

  return { imported_memories: importedMemories, imported_chunks: importedChunks };
}


export function chunkText(text: string, chunkSize = 800, overlap = 100): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);

  const pushChunk = (chunk: string) => {
    const trimmed = chunk.trim();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
  };

  let buffer = "";
  const flushBuffer = () => {
    if (buffer.trim().length > 0) {
      pushChunk(buffer);
      buffer = "";
    }
  };

  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      flushBuffer();
      let start = 0;
      while (start < para.length) {
        const end = Math.min(start + chunkSize, para.length);
        pushChunk(para.slice(start, end));
        if (end === para.length) break;
        start = Math.max(end - overlap, start + 1);
      }
      continue;
    }

    if (buffer.length === 0) {
      buffer = para;
      continue;
    }

    const candidate = `${buffer}\n\n${para}`;
    if (candidate.length <= chunkSize) {
      buffer = candidate;
    } else {
      flushBuffer();
      buffer = para;
    }
  }

  flushBuffer();
  return chunks;
}

const EMBED_MAX_RETRIES = RETRY_MAX_ATTEMPTS;
const EMBED_RETRY_DELAYS_MS = OPENAI_EMBED_RETRY_DELAYS_MS;

/** Retry fetch on 5xx, 429, or network error. Does not retry on 4xx (except 429). Request-level timeout per attempt. */
async function fetchWithRetry(
  url: string,
  init: RequestInit & { body: string },
  options?: { maxRetries?: number; delaysMs?: number[]; timeoutMs?: number },
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? EMBED_MAX_RETRIES;
  const delaysMs = options?.delaysMs ?? EMBED_RETRY_DELAYS_MS;
  const timeoutMs = options?.timeoutMs ?? EMBED_REQUEST_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    const signal = controller.signal;
    try {
      const res = await fetch(url, { ...init, signal, body: init.body });
      if (timeoutId) clearTimeout(timeoutId);
      const retryable = res.status === 429 || res.status >= 500;
      if (!res.ok && !retryable) return res;
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
      if (attempt < maxRetries) {
        const delayMs = delaysMs[attempt] ?? 1000;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      lastError = err;
      if (attempt < maxRetries) {
        const delayMs = delaysMs[attempt] ?? 1000;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

export interface EmbedResult {
  embeddings: number[][];
  tokensUsed: number;
}

async function embedText(texts: string[], env: Env): Promise<EmbedResult> {
  const mode = (env.EMBEDDINGS_MODE || "openai").toLowerCase();
  if (mode === "stub") {
    const estimatedTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    return { embeddings: texts.map((t) => stubEmbedding(t)), tokensUsed: estimatedTokens };
  }

  if (!env.OPENAI_API_KEY) {
    throw createHttpError(500, "CONFIG_ERROR", "OPENAI_API_KEY not set");
  }

  const embedStart = Date.now();
  const body = JSON.stringify({
    model: "text-embedding-3-small",
    input: texts,
  });
  let response: Response;
  try {
    response = await withCircuitBreaker("openai", () =>
      fetchWithRetry(
        "https://api.openai.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body,
        },
        { timeoutMs: EMBED_REQUEST_TIMEOUT_MS },
      ),
    env,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("CIRCUIT_OPEN:")) {
      throw createHttpError(503, "SERVICE_UNAVAILABLE", "Embedding service temporarily unavailable");
    }
    throw err;
  }

  if (!response.ok) {
    const embedLatency = Date.now() - embedStart;
    const rawErrorBody = await response.text();
    logger.error({
      event: "embed_request",
      embed_latency_ms: embedLatency,
      embed_count: texts.length,
      status: response.status,
      success: false,
      upstream_error: redact(rawErrorBody, "upstream_error"),
    });
    throw createHttpError(500, "EMBED_ERROR", `Embedding service returned HTTP ${response.status}`);
  }

  const json = (await response.json()) as {
    data: { embedding: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };

  const tokensUsed = json.usage?.total_tokens ?? texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);

  const embedLatency = Date.now() - embedStart;
  logger.info({
    event: "embed_request",
    embed_latency_ms: embedLatency,
    embed_count: texts.length,
    tokens_used: tokensUsed,
    status: response.status,
    success: true,
  });

  if (!json.data || json.data.length !== texts.length) {
    throw createHttpError(500, "EMBED_ERROR", "Embedding response missing data");
  }

  return { embeddings: json.data.map((item) => item.embedding), tokensUsed };
}

function vectorToPgvectorString(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

type MatchResult = {
  chunk_id: string;
  memory_id: string;
  chunk_index: number;
  chunk_text: string;
  score: number;
};

type FusionResult = {
  chunk_id: string;
  memory_id: string;
  chunk_index: number;
  text: string;
  score: number;
  _explain?: {
    rrf_score: number;
    match_sources: ("vector" | "text")[];
    vector_score?: number;
    text_score?: number;
  };
};

async function callMatchVector(
  supabase: SupabaseClient,
  args: {
    workspaceId: string;
    userId: string;
    namespace: string;
    queryEmbedding: string;
    matchCount: number;
    metadata?: MetadataFilter;
    startTime?: string;
    endTime?: string;
    memoryTypes?: string[];
    filterMode?: string;
  },
): Promise<MatchResult[]> {
  const rpcStart = Date.now();
  const { data, error } = await supabase.rpc("match_chunks_vector", {
    p_workspace_id: args.workspaceId,
    p_user_id: args.userId,
    p_namespace: args.namespace,
    p_query_embedding: args.queryEmbedding,
    p_match_count: args.matchCount,
    p_metadata: args.metadata ?? null,
    p_start_time: args.startTime ?? null,
    p_end_time: args.endTime ?? null,
    p_memory_types: args.memoryTypes ?? null,
    p_filter_mode: args.filterMode ?? "and",
  });
  const dbLatency = Date.now() - rpcStart;

  if (error) {
    logger.error({
      event: "db_rpc",
      rpc: "match_chunks_vector",
      db_latency_ms: dbLatency,
      success: false,
    });
    throw createHttpError(500, "DB_ERROR", `match_chunks_vector failed: ${error.message}`);
  }
  logger.info({
    event: "db_rpc",
    rpc: "match_chunks_vector",
    db_latency_ms: dbLatency,
    result_count: (data ?? []).length,
    success: true,
  });
  return (data ?? []) as MatchResult[];
}

/**
 * Update last_accessed_at for chunks returned in search. Fire-and-forget only; never await.
 * Enforces workspace_id. Swallows errors.
 */
function bumpChunkAccess(
  supabase: SupabaseClient,
  workspaceId: string,
  chunkIds: string[],
): void {
  if (chunkIds.length === 0) return;
  const p = supabase
    .from("memory_chunks")
    .update({ last_accessed_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .in("id", chunkIds);
  void Promise.resolve(p).catch(() => {});
}

async function callMatchText(
  supabase: SupabaseClient,
  args: {
    workspaceId: string;
    userId: string;
    namespace: string;
    query: string;
    matchCount: number;
    metadata?: MetadataFilter;
    startTime?: string;
    endTime?: string;
    memoryTypes?: string[];
    filterMode?: string;
  },
): Promise<MatchResult[]> {
  const rpcStart = Date.now();
  const { data, error } = await supabase.rpc("match_chunks_text", {
    p_workspace_id: args.workspaceId,
    p_user_id: args.userId,
    p_namespace: args.namespace,
    p_query: args.query,
    p_match_count: args.matchCount,
    p_metadata: args.metadata ?? null,
    p_start_time: args.startTime ?? null,
    p_end_time: args.endTime ?? null,
    p_memory_types: args.memoryTypes ?? null,
    p_filter_mode: args.filterMode ?? "and",
  });
  const dbLatency = Date.now() - rpcStart;
  if (error) {
    logger.error({
      event: "db_rpc",
      rpc: "match_chunks_text",
      db_latency_ms: dbLatency,
      success: false,
    });
    throw createHttpError(500, "DB_ERROR", `match_chunks_text failed: ${error.message}`);
  }
  logger.info({
    event: "db_rpc",
    rpc: "match_chunks_text",
    db_latency_ms: dbLatency,
    result_count: (data ?? []).length,
    success: true,
  });
  return (data ?? []) as MatchResult[];
}

function reciprocalRankFusion(
  vectorResults: MatchResult[],
  textResults: MatchResult[],
  topK: number,
  includeExplain: boolean,
): FusionResult[] {
  const scores = new Map<
    string,
    FusionResult & { rrf: number; vectorScore?: number; textScore?: number; matchSources: ("vector" | "text")[] }
  >();

  const applyList = (list: MatchResult[], source: "vector" | "text") => {
    list.forEach((item, idx) => {
      const rrfScore = 1 / (RRF_K + idx + 1);
      const existing = scores.get(item.chunk_id);
      const combinedScore = (existing?.rrf ?? 0) + rrfScore;
      const matchSources = existing?.matchSources ?? [];
      if (!matchSources.includes(source)) matchSources.push(source);
      scores.set(item.chunk_id, {
        chunk_id: item.chunk_id,
        memory_id: item.memory_id,
        chunk_index: item.chunk_index,
        text: item.chunk_text,
        score: combinedScore,
        rrf: combinedScore,
        ...(source === "vector"
          ? { vectorScore: item.score, textScore: existing?.textScore }
          : { vectorScore: existing?.vectorScore, textScore: item.score }),
        matchSources,
      });
    });
  };

  applyList(vectorResults, "vector");
  applyList(textResults, "text");

  return Array.from(scores.values())
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (Math.abs(diff) > 1e-12) return diff;
      return a.chunk_id.localeCompare(b.chunk_id);
    })
    .slice(0, topK)
    .map(({ rrf, vectorScore, textScore, matchSources, ...rest }) => {
      const result: FusionResult = rest;
      if (includeExplain) {
        result._explain = {
          rrf_score: rrf,
          match_sources: matchSources,
          ...(vectorScore !== undefined ? { vector_score: vectorScore } : {}),
          ...(textScore !== undefined ? { text_score: textScore } : {}),
        };
      }
      return result;
    });
}

function normalizeTextKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function dedupeFusionResults(results: FusionResult[]): FusionResult[] {
  const seen = new Set<string>();
  const deduped: FusionResult[] = [];
  for (const res of results) {
    const key = normalizeTextKey(res.text);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(res);
  }
  return deduped;
}

type SearchOutcome = {
  results: FusionResult[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
};

type ListOutcome = {
  results: {
    id: string;
    user_id: string;
    namespace: string;
    text: string;
    metadata: Record<string, unknown>;
    created_at: string;
    memory_type?: string | null;
    source_memory_id?: string | null;
  }[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
};

type ExportOutcome = { artifact_base64: string; bytes: number; sha256: string; archive: Uint8Array };

type ImportOutcome = { imported_memories: number; imported_chunks: number };

export function finalizeResults(
  fused: FusionResult[],
  page: number,
  page_size: number,
): { results: FusionResult[]; total: number; has_more: boolean } {
  const deduped = dedupeFusionResults(fused);
  const offset = (page - 1) * page_size;
  const paged = deduped.slice(offset, offset + page_size);
  const total = deduped.length;
  return { results: paged, total, has_more: offset + page_size < total };
}

async function performSearch(
  auth: AuthContext,
  payload: SearchPayload,
  env: Env,
  supabase: SupabaseClient,
): Promise<SearchOutcome> {
  const searchStart = Date.now();
  const params = normalizeSearchPayload(payload);
  const { user_id, query, namespace, top_k, page, page_size, explain, search_mode, min_score, filters } = params;

  const needsVector = search_mode === "hybrid" || search_mode === "vector";
  if (needsVector) {
    try {
      await checkGlobalCostGuard(supabase, env);
    } catch (e) {
      if (e instanceof AIBudgetExceededError) {
        throw createHttpError(503, "ai_budget_exceeded", "AI usage temporarily paused due to budget protection.");
      }
      throw e;
    }
  }

  const desired = Math.min(MAX_FUSE_RESULTS, Math.max(top_k, page * page_size));
  const matchCount = Math.min(SEARCH_MATCH_COUNT, desired * 3);

  const needsKeyword = search_mode === "hybrid" || search_mode === "keyword";

  const sharedArgs = {
    workspaceId: auth.workspaceId,
    userId: user_id,
    namespace,
    matchCount,
    metadata: filters.metadata,
    startTime: filters.start_time,
    endTime: filters.end_time,
    memoryTypes: filters.memory_types,
    filterMode: filters.filter_mode,
  };

  let vectorResults: MatchResult[] = [];
  let textResults: MatchResult[] = [];

  if (needsVector && needsKeyword) {
    const embedResult = await embedText([query], env);
    const embeddingVector = vectorToPgvectorString(embedResult.embeddings[0]);
    [vectorResults, textResults] = await Promise.all([
      callMatchVector(supabase, { ...sharedArgs, queryEmbedding: embeddingVector }),
      callMatchText(supabase, { ...sharedArgs, query }),
    ]);
  } else if (needsVector) {
    const embedResult = await embedText([query], env);
    const embeddingVector = vectorToPgvectorString(embedResult.embeddings[0]);
    vectorResults = await callMatchVector(supabase, { ...sharedArgs, queryEmbedding: embeddingVector });
  } else {
    textResults = await callMatchText(supabase, { ...sharedArgs, query });
  }

  /* Quota reserved by caller (search/context/eval) via reserveQuotaAndMaybeRespond before calling performSearch. */
  const fused = reciprocalRankFusion(
    vectorResults,
    textResults,
    Math.min(matchCount, MAX_FUSE_RESULTS),
    !!explain,
  );

  const scored = min_score != null
    ? fused.filter((r) => r.score >= min_score)
    : fused;

  const final = finalizeResults(scored, page, page_size);

  if (final.results.length > 0) {
    bumpChunkAccess(supabase, auth.workspaceId, final.results.map((r) => r.chunk_id));
  }

  const searchLatency = Date.now() - searchStart;
  logger.info({
    event: "search_request",
    search_latency_ms: searchLatency,
    search_mode,
    result_count: final.total,
    page,
    page_size,
  });

  return {
    results: final.results,
    total: final.total,
    page,
    page_size,
    has_more: final.has_more,
  };
}

export async function performListMemories(
  auth: AuthContext,
  params: MemoryListParams,
  supabase: SupabaseClient,
): Promise<ListOutcome> {
  const { page, page_size, namespace, user_id, memory_type, filters } = params;
  const offset = (page - 1) * page_size;

  let query = supabase
    .from("memories")
    .select("id, user_id, namespace, text, metadata, created_at, memory_type, source_memory_id", { count: "exact" })
    .eq("workspace_id", auth.workspaceId)
    .is("duplicate_of", null);

  if (namespace) query = query.eq("namespace", namespace);
  if (user_id) query = query.eq("user_id", user_id);
  if (memory_type) query = query.eq("memory_type", memory_type);
  if (filters.metadata) query = query.contains("metadata", filters.metadata);
  if (filters.start_time) query = query.gte("created_at", filters.start_time);
  if (filters.end_time) query = query.lte("created_at", filters.end_time);

  query = query.order("created_at", { ascending: false }).order("id", { ascending: false });
  query = query.range(offset, offset + page_size - 1);

  const { data, error, count } = await query;
  if (error) {
    throw createHttpError(500, "DB_ERROR", error.message ?? "Failed to list memories");
  }

  const total = typeof count === "number" ? count : data?.length ?? 0;
  const has_more = offset + (data?.length ?? 0) < total;

  return {
    results: (data ?? []) as ListOutcome["results"],
    total,
    page,
    page_size,
    has_more,
  };
}

export { parseApiKeyMeta, redact };

// Stub embeddings (deterministic) for dev
const STUB_EMBED_DIM = 1536;
function stubEmbedding(text: string): number[] {
  const seed = hashStringToInt(text);
  const rng = mulberry32(seed);
  const arr = new Array(STUB_EMBED_DIM);
  for (let i = 0; i < STUB_EMBED_DIM; i++) {
    arr[i] = rng() * 2 - 1; // [-1, 1)
  }
  return arr;
}

function hashStringToInt(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0) || 1;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Usage accounting
type UsageRow = {
  workspace_id: string;
  day: string;
  writes: number;
  reads: number;
  embeds: number;
  extraction_calls?: number;
  embed_tokens_used?: number;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getUsage(
  supabase: SupabaseClient,
  workspaceId: string,
  day: string,
): Promise<UsageRow> {
  const { data, error } = await supabase
    .from("usage_daily")
    .select("workspace_id, day, writes, reads, embeds, extraction_calls, embed_tokens_used")
    .eq("workspace_id", workspaceId)
    .eq("day", day)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw createHttpError(500, "DB_ERROR", `Failed to fetch usage: ${error.message}`);
  }

  if (!data) {
    return {
      workspace_id: workspaceId,
      day,
      writes: 0,
      reads: 0,
      embeds: 0,
      extraction_calls: 0,
      embed_tokens_used: 0,
    };
  }

  const row = data as Record<string, unknown>;
  return {
    workspace_id: workspaceId,
    day,
    writes: Number(row.writes) ?? 0,
    reads: Number(row.reads) ?? 0,
    embeds: Number(row.embeds) ?? 0,
    extraction_calls: Number(row.extraction_calls) ?? 0,
    embed_tokens_used: Number(row.embed_tokens_used) ?? 0,
  };
}

async function bumpUsage(
  supabase: SupabaseClient,
  workspaceId: string,
  day: string,
  deltas: { writesDelta: number; readsDelta: number; embedsDelta: number },
): Promise<UsageRow> {
  const { data, error } = await supabase.rpc("bump_usage_rpc", {
    p_workspace_id: workspaceId,
    p_day: day,
    p_writes: deltas.writesDelta,
    p_reads: deltas.readsDelta,
    p_embeds: deltas.embedsDelta,
  });

  if (error || !data) {
    throw createHttpError(500, "DB_ERROR", `Failed to bump usage: ${error?.message}`);
  }

  return data as UsageRow;
}

/** Estimate embed tokens from text length: ceil(len/4). */
function estimateEmbedTokens(textLength: number): number {
  return Math.ceil(Math.max(0, textLength) / 4);
}

/** Result of atomic cap check + bump. On success usage was incremented; on exceeded nothing was changed. */
type BumpWithinCapResult =
  | { ok: true; usage: UsageRow }
  | { ok: false; limit: string; used: number; cap: number };

async function bumpUsageIfWithinCap(
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
  planLimits: PlanLimits,
): Promise<BumpWithinCapResult> {
  const caps = {
    writes: planLimits.writes_per_day,
    reads: planLimits.reads_per_day,
    embeds: Math.floor(planLimits.embed_tokens_per_day / 200),
    embed_tokens: planLimits.embed_tokens_per_day,
    extraction_calls: planLimits.extraction_calls_per_day,
  };
  const { data, error } = await supabase.rpc("bump_usage_if_within_cap", {
    p_workspace_id: workspaceId,
    p_day: day,
    p_writes: deltas.writesDelta,
    p_reads: deltas.readsDelta,
    p_embeds: deltas.embedsDelta,
    p_embed_tokens: deltas.embedTokensDelta,
    p_extraction_calls: deltas.extractionCallsDelta,
    p_writes_cap: caps.writes,
    p_reads_cap: caps.reads,
    p_embeds_cap: caps.embeds,
    p_embed_tokens_cap: caps.embed_tokens,
    p_extraction_calls_cap: caps.extraction_calls,
  });

  if (error) {
    throw createHttpError(500, "DB_ERROR", `Failed to bump usage: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const row = rows[0] as
    | { exceeded?: boolean; limit_name?: string; writes?: number; reads?: number; embeds?: number; extraction_calls?: number; embed_tokens_used?: number }
    | undefined;
  if (!row) {
    throw createHttpError(500, "DB_ERROR", "bump_usage_if_within_cap returned no row");
  }
  if (row.exceeded === true && row.limit_name) {
    const used =
      row.limit_name === "writes"
        ? (row.writes ?? 0)
        : row.limit_name === "reads"
          ? (row.reads ?? 0)
          : row.limit_name === "embeds"
            ? (row.embeds ?? 0)
            : row.limit_name === "embed_tokens"
              ? (row.embed_tokens_used ?? 0)
              : row.limit_name === "extraction_calls"
                ? (row.extraction_calls ?? 0)
                : 0;
    const cap =
      row.limit_name === "writes"
        ? caps.writes
        : row.limit_name === "reads"
          ? caps.reads
          : row.limit_name === "embeds"
            ? caps.embeds
            : row.limit_name === "embed_tokens"
              ? caps.embed_tokens
              : row.limit_name === "extraction_calls"
                ? caps.extraction_calls
                : 0;
    return { ok: false, limit: row.limit_name, used, cap };
  }
  return {
    ok: true,
    usage: {
      workspace_id: workspaceId,
      day,
      writes: row.writes ?? 0,
      reads: row.reads ?? 0,
      embeds: row.embeds ?? 0,
      extraction_calls: row.extraction_calls ?? 0,
      embed_tokens_used: row.embed_tokens_used ?? 0,
    },
  };
}

async function reserveQuotaAndMaybeRespond(
  quota: { planLimits: PlanLimits; blocked: boolean },
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
): Promise<Response | null> {
  if (quota.blocked) return null;
  const result = await bumpUsageIfWithinCap(
    supabase,
    workspaceId,
    day,
    deltas,
    quota.planLimits,
  );
  if (!result.ok) {
    return planLimitExceededResponse(
      result.limit,
      result.used,
      result.cap,
      rateHeaders,
      jsonResponse,
      env,
    );
  }
  return null;
}

export async function deleteMemoryCascade(
  supabase: SupabaseClient,
  workspaceId: string,
  memoryId: string,
): Promise<boolean> {
  const { error: chunksError } = await supabase
    .from("memory_chunks")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("memory_id", memoryId);

  if (chunksError) {
    throw createHttpError(500, "DB_ERROR", chunksError.message ?? "Failed to delete memory chunks");
  }

  const { error: memError, count } = await supabase
    .from("memories")
    .delete({ count: "exact" })
    .eq("workspace_id", workspaceId)
    .eq("id", memoryId);

  if (memError) {
    throw createHttpError(500, "DB_ERROR", memError.message ?? "Failed to delete memory");
  }

  return (count ?? 0) > 0;
}

/** Full deps for memory handlers when called directly (e.g. from tests). Defined after all helpers. */
const defaultMemoryHandlerDeps: MemoryHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  chunkText,
  embedText,
  todayUtc,
  vectorToPgvectorString,
  emitProductEvent,
  bumpUsage,
  effectivePlan,
  normalizeMemoryListParams,
  performListMemories,
  deleteMemoryCascade,
  checkCapsAndMaybeRespond,
  resolveQuotaForWorkspace,
  reserveQuotaAndMaybeRespond,
  planLimitExceededResponse,
  estimateEmbedTokens,
};

const memoryHandlersDefault = createMemoryHandlers(defaultMemoryHandlerDeps, defaultMemoryHandlerDeps);

/** Full deps for search handler when called directly (e.g. from tests). */
const defaultSearchHandlerDeps: SearchHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  resolveQuotaForWorkspace,
  rateLimitWorkspace,
  reserveQuotaAndMaybeRespond,
  todayUtc,
  estimateEmbedTokens,
  performSearch,
  emitProductEvent,
  effectivePlan,
};

const searchHandlersDefault = createSearchHandlers(defaultSearchHandlerDeps, defaultSearchHandlerDeps);
const contextHandlersDefault = createContextHandlers(defaultSearchHandlerDeps, defaultSearchHandlerDeps);

const defaultEvalHandlerDeps: EvalHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  resolveQuotaForWorkspace,
  rateLimitWorkspace,
  reserveQuotaAndMaybeRespond,
  todayUtc,
  estimateEmbedTokens,
  performSearch,
};
const evalHandlersDefault = createEvalHandlers(defaultEvalHandlerDeps, defaultEvalHandlerDeps);

const defaultEpisodeHandlerDeps: HandlerDeps = {
  jsonResponse: simpleJsonResponse,
};
const episodeHandlersDefault = createEpisodeHandlers(defaultEpisodeHandlerDeps, defaultEpisodeHandlerDeps);

/** Full deps for usage handler when called directly (e.g. from tests). */
const defaultUsageHandlerDeps: UsageHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  todayUtc,
  getUsage,
  resolveQuotaForWorkspace,
};
const usageHandlersDefault = createUsageHandlers(defaultUsageHandlerDeps, defaultUsageHandlerDeps);

/** Full deps for billing handlers (PayU logic remains in index). */
const defaultBillingHandlerDeps: BillingHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  normalizePlanStatus,
  resolveQuotaForWorkspace,
  emitEventLog,
  redact,
  isPayUBillingConfigured,
  assertPayUEnvFor,
  shortHash,
  fetchPayUTransactionByTxnId,
  formatAmountStrict,
  normalizeCurrency,
  transitionPayUTransactionStatus: transitionPayUTransactionStatus as BillingHandlerDeps["transitionPayUTransactionStatus"],
  buildPayURequestHashInput,
  computeSha512Hex,
  normalizePayUBaseUrl,
  emitProductEvent,
  resolveEntitlementPlanCode,
  getAmountForPlan: resolvePayUAmountForPlan,
  getProductInfoForPlan: resolveProductInfoForPlan,
  defaultSuccessPath: DEFAULT_SUCCESS_PATH,
  defaultCancelPath: DEFAULT_CANCEL_PATH,
  defaultProductInfo: DEFAULT_PAYU_PRODUCT_INFO,
};
const billingHandlersDefault = createBillingHandlers(defaultBillingHandlerDeps, defaultBillingHandlerDeps);

/** Full deps for webhook handler (PayU logic remains in index). */
const defaultWebhookHandlerDeps: WebhookHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  resolveBillingWebhooksEnabled,
  assertPayUEnvFor,
  emitEventLog,
  parseWebhookPayload: parseWebhookPayload as WebhookHandlerDeps["parseWebhookPayload"],
  asNonEmptyString,
  isPayUWebhookSignatureValid: isPayUWebhookSignatureValid as WebhookHandlerDeps["isPayUWebhookSignatureValid"],
  resolvePayUEventId: resolvePayUEventId as WebhookHandlerDeps["resolvePayUEventId"],
  resolvePayUEventType: resolvePayUEventType as WebhookHandlerDeps["resolvePayUEventType"],
  resolvePayUEventCreated: resolvePayUEventCreated as WebhookHandlerDeps["resolvePayUEventCreated"],
  reconcilePayUWebhook: reconcilePayUWebhook as WebhookHandlerDeps["reconcilePayUWebhook"],
  redact,
  logger: logger as unknown as WebhookHandlerDeps["logger"],
  isApiError,
};
const webhookHandlersDefault = createWebhookHandlers(defaultWebhookHandlerDeps, defaultWebhookHandlerDeps);

/** Full deps for admin handlers (PayU/billing logic remains in index). */
const defaultAdminHandlerDeps: AdminHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  requireAdmin,
  rateLimit,
  emitEventLog,
  redact,
  reconcilePayUWebhook: reconcilePayUWebhook as AdminHandlerDeps["reconcilePayUWebhook"],
  defaultWebhookReprocessLimit: DEFAULT_WEBHOOK_REPROCESS_LIMIT,
  asNonEmptyString,
  resolvePayUVerifyTimeoutMs,
  resolveBillingWebhooksEnabled,
  normalizeCurrency,
};
const adminHandlersDefault = createAdminHandlers(defaultAdminHandlerDeps, defaultAdminHandlerDeps);

const defaultExportHandlerDeps: ExportHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  wantsZipResponse,
  buildExportArtifact: buildExportArtifact as ExportHandlerDeps["buildExportArtifact"],
  makeExportResponse: (outcome, wantsZip, auth, rateHeaders) =>
    makeExportResponse(outcome, wantsZip, auth, rateHeaders, {}),
  defaultMaxExportBytes: DEFAULT_MAX_EXPORT_BYTES,
};
const exportHandlersDefault = createExportHandlers(defaultExportHandlerDeps, defaultExportHandlerDeps);

const defaultImportHandlerDeps: ImportHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  resolveQuotaForWorkspace,
  reserveQuotaAndMaybeRespond,
  todayUtc,
  importArtifact: importArtifact as ImportHandlerDeps["importArtifact"],
  defaultMaxImportBytes: DEFAULT_MAX_IMPORT_BYTES,
};
const importHandlersDefault = createImportHandlers(defaultImportHandlerDeps, defaultImportHandlerDeps);

const defaultWorkspacesHandlerDeps: WorkspacesHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  requireAdmin,
  rateLimit,
  emitProductEvent,
};
const workspacesHandlersDefault = createWorkspacesHandlers(defaultWorkspacesHandlerDeps, defaultWorkspacesHandlerDeps);

const defaultApiKeysHandlerDeps: ApiKeysHandlerDeps = {
  jsonResponse: simpleJsonResponse,
  safeParseJson,
  requireAdmin,
  rateLimit,
  generateApiKey,
  getApiKeySalt,
  hashApiKey,
  emitProductEvent,
  setStubApiKeyIfPresent,
};
const apiKeysHandlersDefault = createApiKeysHandlers(defaultApiKeysHandlerDeps, defaultApiKeysHandlerDeps);

export const handleCreateMemory = memoryHandlersDefault.handleCreateMemory;
export const handleListMemories = memoryHandlersDefault.handleListMemories;
export const handleGetMemory = memoryHandlersDefault.handleGetMemory;
export const handleDeleteMemory = memoryHandlersDefault.handleDeleteMemory;
export const handleSearch = searchHandlersDefault.handleSearch;
export const handleCreateEpisode = episodeHandlersDefault.handleCreateEpisode;
export const handleListEpisodes = episodeHandlersDefault.handleListEpisodes;
export const handleContext = contextHandlersDefault.handleContext;
export const handleUsageToday = usageHandlersDefault.handleUsageToday;
export const handleBillingStatus = billingHandlersDefault.handleBillingStatus;
export const handleBillingCheckout = billingHandlersDefault.handleBillingCheckout;
export const handleBillingPortal = billingHandlersDefault.handleBillingPortal;
export const handleBillingWebhook = webhookHandlersDefault.handleBillingWebhook;
export const handleReprocessDeferredWebhooks = adminHandlersDefault.handleReprocessDeferredWebhooks;
export const handleAdminBillingHealth = adminHandlersDefault.handleAdminBillingHealth;
export const handleCleanupExpiredSessions = adminHandlersDefault.handleCleanupExpiredSessions;
export const handleMemoryHygiene = adminHandlersDefault.handleMemoryHygiene;
export const handleExport = exportHandlersDefault.handleExport;
export const handleImport = importHandlersDefault.handleImport;
export const handleRunEval = evalHandlersDefault.handleRunEval;
export const handleCreateWorkspace = workspacesHandlersDefault.handleCreateWorkspace;
export const handleCreateApiKey = apiKeysHandlersDefault.handleCreateApiKey;
export const handleListApiKeys = apiKeysHandlersDefault.handleListApiKeys;
export const handleRevokeApiKey = apiKeysHandlersDefault.handleRevokeApiKey;

// Rate limiting backed by KV (survives restarts)
export function safeKvTtl(ttlSec: number): number {
  const numeric = Number.isFinite(ttlSec) ? Number(ttlSec) : 0;
  if (numeric <= 0) return 60;
  return Math.max(60, Math.ceil(numeric));
}

export { performSearch };

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `mn_live_${hex}`;
}

function setStubApiKeyIfPresent(
  supabase: SupabaseClient,
  rawKey: string,
  workspaceId: string,
): void {
  const stubKeys = (supabase as unknown as { __rawApiKeys?: Map<string, { workspaceId: string }> }).__rawApiKeys;
  if (stubKeys) stubKeys.set(rawKey, { workspaceId });
}

// ---------- Export / Import ----------
export function makeExportResponse(
  outcome: ExportOutcome,
  wantsZip: boolean,
  auth: AuthContext,
  rateHeaders: Record<string, string>,
  baseHeaders: Record<string, string>,
): Response {
  if (wantsZip) {
    const date = new Date().toISOString().slice(0, 10);
    const buf = outcome.archive.buffer
      .slice(outcome.archive.byteOffset, outcome.archive.byteOffset + outcome.archive.byteLength) as ArrayBuffer;
    const headers = {
      ...rateHeaders,
      ...baseHeaders,
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="memorynode-export-${auth.workspaceId}-${date}.zip"`,
    };
    return new Response(buf as BodyInit, { status: 200, headers });
  }

  return new Response(
    JSON.stringify({ artifact_base64: outcome.artifact_base64, bytes: outcome.bytes, sha256: outcome.sha256 }),
    {
      status: 200,
      headers: { "content-type": "application/json", ...rateHeaders, ...baseHeaders },
    },
  );
}

function resolveBillingWebhooksEnabled(env: Env): boolean {
  const raw = (env.BILLING_WEBHOOKS_ENABLED ?? "1").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return true;
}

function resolvePayUEventId(payload: PayUWebhookPayload): string {
  const paymentId = asNonEmptyString(payload.mihpayid);
  if (paymentId) return paymentId;
  const txnId = asNonEmptyString(payload.txnid) ?? "unknown_txn";
  const status = asNonEmptyString(payload.status) ?? "unknown_status";
  const created = resolvePayUEventCreated(payload);
  return `${txnId}:${status}:${created}`;
}

function resolvePayUEventType(payload: PayUWebhookPayload): string {
  return `payment.${normalizePayUStatus(payload.status)}`;
}

function resolvePayUEventCreated(payload: PayUWebhookPayload): number {
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

type PayUReconcileWebhookResult = {
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
      status: "processing",
      request_id: requestId || null,
      payload,
      processed_at: null,
      last_error: null,
    })
    .select("event_id,status")
    .maybeSingle();
  if (!inserted.error) return { replayed: false };
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
  if (existingStatus === "failed" || existingStatus === "deferred") {
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
): Promise<void> {
  const message = redact((err as Error)?.message, "message");
  const fail = await supabase
    .from("payu_webhook_events")
    .update({
      status: "failed",
      last_error: typeof message === "string" ? message : "Webhook processing failed",
      processed_at: null,
      defer_reason: null,
    })
    .eq("event_id", eventId);
  if (fail.error) {
    logger.error({
      event: "webhook_event_mark_failed_error",
      payu_event_id: eventId,
      error_message: fail.error.message,
      err: fail.error,
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

async function reconcilePayUWebhook(
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
          lastError: txnMatches && amountMatches && currencyMatches
            ? "verify_status_not_success"
            : "verify_payload_mismatch",
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
        const shouldApply = shouldApplyPayUEvent(current?.payu_last_event_created, current?.payu_last_event_id, eventCreated, eventId);
        if (!shouldApply) {
          outcome = "ignored_stale";
        } else {
          const planCode = resolveEntitlementPlanCode(txn.plan_code);
          const effectivePlanCode = payuStatus === "success" ? authPlanFromEntitlement(planCode) : "free";
          const planStatus = payuStatus === "success" ? "active" : planStatusFromPayUStatus(payuStatus);
          const oldStatus = normalizePlanStatus(current?.plan_status);
          const workspacePlanForDb: AuthContext["plan"] = payuStatus === "success" ? "pro" : "free";
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
            void emitProductEvent(
              supabase,
              "upgrade_activated",
              {
                workspaceId,
                requestId,
                route: "/v1/billing/webhook",
                method: "POST",
                status: 200,
                effectivePlan: effectivePlanCode,
                planStatus,
              },
            );
          }
        }
      }
    }

    await finalizePayUWebhookEvent(
      supabase,
      eventId,
      outcome,
      { workspaceId, txnId, paymentId, payuStatus, requestId, deferReason },
    );
  } catch (err) {
    await failPayUWebhookEvent(supabase, eventId, err);
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


