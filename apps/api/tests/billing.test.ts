import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPayURequestHashInput,
  buildPayUResponseReverseHashInput,
  computeSha512Hex,
  handleBillingStatus,
  handleBillingCheckout,
  handleBillingPortal,
  handleBillingWebhook,
  handleAdminBillingHealth,
  handleUsageToday,
  handleSearch,
  handleCreateMemory,
  handleContext,
} from "../src/index.js";
import { capsByPlan } from "../src/limits.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateLimitDo = makeRateLimitDoStub();

type WorkspaceRow = {
  id: string;
  plan: "free" | "pro" | "team";
  plan_status: "free" | "trialing" | "active" | "past_due" | "canceled";
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  billing_provider: string;
  payu_txn_id: string | null;
  payu_payment_id: string | null;
  payu_last_status: string | null;
  payu_last_event_id: string | null;
  payu_last_event_created: number | null;
};

type PayUWebhookRow = {
  event_id: string;
  status?: string | null;
  event_type?: string | null;
  event_created?: number | null;
  processed_at?: string | null;
  request_id?: string | null;
  workspace_id?: string | null;
  txn_id?: string | null;
  payment_id?: string | null;
  payu_status?: string | null;
  defer_reason?: string | null;
  last_error?: string | null;
  payload?: Record<string, unknown>;
};

type PayUTransactionRow = {
  txn_id: string;
  workspace_id: string;
  plan_code: string;
  amount: string;
  currency: string;
  status: string;
  payu_payment_id?: string | null;
  verify_status?: string | null;
  verify_payload?: Record<string, unknown> | null;
  request_id?: string | null;
  last_error?: string | null;
  updated_at?: string | null;
};

type WorkspaceEntitlementRow = {
  id: number;
  workspace_id: string;
  source_txn_id: string;
  plan_code: string;
  status: string;
  starts_at: string;
  expires_at: string | null;
  caps_json: { writes: number; reads: number; embeds: number };
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

function makeSupabase(options?: {
  plan?: WorkspaceRow["plan"];
  plan_status?: WorkspaceRow["plan_status"];
  workspace?: Partial<WorkspaceRow>;
  usage?: { writes: number; reads: number; embeds: number };
  failWorkspaceUpdates?: number;
}) {
  const workspace: WorkspaceRow = {
    id: options?.workspace?.id ?? "ws1",
    plan: options?.plan ?? options?.workspace?.plan ?? "free",
    plan_status: options?.plan_status ?? options?.workspace?.plan_status ?? "free",
    current_period_end: options?.workspace?.current_period_end ?? null,
    cancel_at_period_end: options?.workspace?.cancel_at_period_end ?? false,
    billing_provider: options?.workspace?.billing_provider ?? "payu",
    payu_txn_id: options?.workspace?.payu_txn_id ?? null,
    payu_payment_id: options?.workspace?.payu_payment_id ?? null,
    payu_last_status: options?.workspace?.payu_last_status ?? null,
    payu_last_event_id: options?.workspace?.payu_last_event_id ?? null,
    payu_last_event_created: options?.workspace?.payu_last_event_created ?? null,
  };

  const usage = options?.usage ?? { writes: 0, reads: 0, embeds: 0 };
  const payuEvents = new Map<string, PayUWebhookRow>();
  const payuTransactions = new Map<string, PayUTransactionRow>();
  const entitlements: WorkspaceEntitlementRow[] = [];
  let entitlementId = 1;
  let billingUpdateCount = 0;
  let remainingWorkspaceUpdateFailures = options?.failWorkspaceUpdates ?? 0;

  return {
    workspace,
    getBillingUpdateCount: () => billingUpdateCount,
    getWebhookRow: (eventId: string) => payuEvents.get(eventId),
    getTransactionRow: (txnId: string) => payuTransactions.get(txnId),
    getEntitlementByTxn: (txnId: string) => entitlements.find((row) => row.source_txn_id === txnId),
    from(table: string) {
      if (table === "app_settings") {
        return {
          select: () => ({
            limit: () => ({
              single: async () => ({ data: { api_key_salt: "salt" }, error: null }),
            }),
          }),
        };
      }
      if (table === "api_keys") {
        const builder = {
          eq: () => builder,
          is: () => builder,
          single: async () => ({
            data: { id: "k1", workspace_id: workspace.id, workspaces: { plan: workspace.plan, plan_status: workspace.plan_status } },
            error: null,
          }),
        };
        return {
          select: () => builder,
        };
      }
      if (table === "workspaces") {
        const filters: Array<[string, unknown]> = [];
        const builder = {
          select: () => builder,
          limit: async () => ({ data: [{ id: workspace.id }], error: null }),
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return builder;
          },
          maybeSingle: async () => {
            const matches = filters.every(([col, val]) => (workspace as Record<string, unknown>)[col] === val);
            return { data: matches ? workspace : null, error: null };
          },
          single: async () => ({ data: workspace, error: null }),
          update: (fields: Partial<WorkspaceRow>) => ({
            eq: () => {
              if (remainingWorkspaceUpdateFailures > 0) {
                remainingWorkspaceUpdateFailures -= 1;
                return { data: null, error: { message: "transient workspace update failure" } };
              }
              billingUpdateCount += 1;
              Object.assign(workspace, fields);
              return { data: [workspace], error: null };
            },
          }),
        };
        return builder;
      }
      if (table === "usage_daily") {
        const builder = {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: usage, error: null }),
              }),
            }),
          }),
        };
        return builder;
      }
      if (table === "memories") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }),
        };
      }
      if (table === "memory_chunks") {
        return {
          insert: () => ({ error: null }),
        };
      }
      if (table === "product_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
          insert: (rows: unknown) => {
            void rows;
            return { error: null };
          },
        };
      }
      if (table === "payu_transactions") {
        const listTransactions = () =>
          Array.from(payuTransactions.values()).sort((a, b) => {
            const aTs = Date.parse(a.updated_at ?? "");
            const bTs = Date.parse(b.updated_at ?? "");
            if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
            return 0;
          });
        return {
          select: () => ({
            eq: (_col: string, val: unknown) => ({
              maybeSingle: async () => ({
                data: payuTransactions.get(String(val)) ?? null,
                error: null,
              }),
            }),
            order: () => ({
              limit: async (n: number) => ({ data: listTransactions().slice(0, n), error: null }),
            }),
          }),
          insert: (rows: Array<PayUTransactionRow> | PayUTransactionRow) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const row = {
              updated_at: new Date().toISOString(),
              ...list[0],
            };
            if (payuTransactions.has(row.txn_id)) {
              return { data: null, error: { code: "23505", message: "duplicate" } };
            }
            payuTransactions.set(row.txn_id, row);
            return { data: [row], error: null };
          },
          update: (fields: Partial<PayUTransactionRow>) => ({
            eq: (_col: string, val: unknown) => {
              const row = payuTransactions.get(String(val));
              if (row) Object.assign(row, fields, { updated_at: new Date().toISOString() });
              return { data: row ? [row] : [], error: null };
            },
          }),
        };
      }
      if (table === "workspace_entitlements") {
        const filters: Array<[string, unknown]> = [];
        const applyFilters = () =>
          entitlements.filter((row) => filters.every(([col, val]) => (row as Record<string, unknown>)[col] === val));
        const builder = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return builder;
          },
          order: () => builder,
          limit: (n: number) => ({ data: applyFilters().slice(0, n), error: null }),
          maybeSingle: async () => ({ data: applyFilters()[0] ?? null, error: null }),
          update: (fields: Partial<WorkspaceEntitlementRow>) => ({
            eq: (_col: string, val: unknown) => {
              const row = entitlements.find((entry) => entry.id === Number(val));
              if (row) Object.assign(row, fields);
              return { data: row ? [row] : [], error: null };
            },
          }),
          insert: (rows: Array<Omit<WorkspaceEntitlementRow, "id">> | Omit<WorkspaceEntitlementRow, "id">) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const inserted = list.map((row) => ({
              ...row,
              id: entitlementId++,
            })) as WorkspaceEntitlementRow[];
            entitlements.push(...inserted);
            return { data: inserted, error: null };
          },
        };
        return {
          select: () => builder,
          insert: builder.insert,
          update: builder.update,
        };
      }
      if (table === "payu_webhook_events") {
        const listEvents = () =>
          Array.from(payuEvents.values()).sort((a, b) => {
            const aTs = typeof a.event_created === "number" ? a.event_created : 0;
            const bTs = typeof b.event_created === "number" ? b.event_created : 0;
            return bTs - aTs;
          });
        return {
          select: () => ({
            eq: (_col: string, val: unknown) => ({
              maybeSingle: async () => ({
                data: payuEvents.get(String(val)) ?? null,
                error: null,
              }),
            }),
            order: () => ({
              limit: async (n: number) => ({ data: listEvents().slice(0, n), error: null }),
            }),
          }),
          insert: (rows: Array<PayUWebhookRow> | PayUWebhookRow) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const row = {
              event_created: Math.floor(Date.now() / 1000),
              ...list[0],
            };
            return {
              select: () => {
                const runner = async () => {
                  if (payuEvents.has(row.event_id)) {
                    return { data: null, error: { code: "23505", message: "duplicate" } };
                  }
                  payuEvents.set(row.event_id, { ...row });
                  return { data: payuEvents.get(row.event_id) ?? null, error: null };
                };
                return {
                  maybeSingle: runner,
                  single: runner,
                };
              },
            };
          },
          update: (fields: Partial<PayUWebhookRow>) => ({
            eq: (_col: string, val: unknown) => {
              const key = String(val);
              const existing = payuEvents.get(key);
              if (existing) Object.assign(existing, fields);
              return { data: existing ? [existing] : [], error: null };
            },
          }),
          order: () => ({
            limit: async () => ({ data: Array.from(payuEvents.values()), error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc() {
      return { data: [], error: null };
    },
  } as unknown as SupabaseClient & {
    workspace: WorkspaceRow;
    getBillingUpdateCount: () => number;
    getWebhookRow: (eventId: string) => PayUWebhookRow | undefined;
    getTransactionRow: (txnId: string) => PayUTransactionRow | undefined;
    getEntitlementByTxn: (txnId: string) => WorkspaceEntitlementRow | undefined;
  };
}

function makeEnv(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    OPENAI_API_KEY: "",
    API_KEY_SALT: "salt",
    MASTER_ADMIN_TOKEN: "",
    RATE_LIMIT_DO: rateLimitDo,
    PAYU_MERCHANT_KEY: "payu_key",
    PAYU_MERCHANT_SALT: "payu_salt",
    PAYU_BASE_URL: "https://secure.payu.in/_payment",
    PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice?form=2",
    PAYU_CURRENCY: "INR",
    PAYU_PRO_AMOUNT: "49.00",
    PAYU_PRODUCT_INFO: "MemoryNode Platform",
    PUBLIC_APP_URL: "https://app.example.com",
    ...overrides,
  };
}

function signPayUWebhook(payload: Record<string, string>, env = makeEnv()) {
  const sequence = buildPayUResponseReverseHashInput(payload, {
    PAYU_MERCHANT_KEY: String(env.PAYU_MERCHANT_KEY ?? ""),
    PAYU_MERCHANT_SALT: String(env.PAYU_MERCHANT_SALT ?? ""),
  });
  return crypto.createHash("sha512").update(sequence).digest("hex");
}

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", realFetch);
});

function mockPayUVerifyApi(status: "success" | "failure" | "pending" | "canceled", options?: {
  amount?: string;
  currency?: string;
  paymentId?: string;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      let txnid = "txn_default";
      const body = init?.body;
      if (body instanceof URLSearchParams) {
        txnid = body.get("var1") ?? txnid;
      } else if (typeof body === "string") {
        txnid = new URLSearchParams(body).get("var1") ?? txnid;
      }
      return new Response(
        JSON.stringify({
          status: 1,
          transaction_details: {
            [txnid]: {
              txnid,
              status,
              amount: options?.amount ?? "49.00",
              currency: options?.currency ?? "INR",
              mihpayid: options?.paymentId ?? `mih_${txnid}`,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

function seedPayUTransaction(
  supabase: SupabaseClient,
  options: {
    txnId: string;
    workspaceId?: string;
    amount?: string;
    currency?: string;
    planCode?: string;
  },
) {
  const inserted = supabase.from("payu_transactions").insert({
    txn_id: options.txnId,
    workspace_id: options.workspaceId ?? "ws1",
    plan_code: options.planCode ?? "pro",
    amount: options.amount ?? "49.00",
    currency: options.currency ?? "INR",
    status: "initiated",
  });
  expect(inserted.error).toBeNull();
}

function seedEntitlement(
  supabase: SupabaseClient,
  options: {
    workspaceId?: string;
    txnId: string;
    status?: "active" | "expired" | "revoked" | "pending";
    planCode?: string;
    startsAt?: string;
    expiresAt?: string | null;
    caps?: { writes: number; reads: number; embeds: number };
  },
) {
  const inserted = supabase.from("workspace_entitlements").insert({
    workspace_id: options.workspaceId ?? "ws1",
    source_txn_id: options.txnId,
    plan_code: options.planCode ?? "pro",
    status: options.status ?? "active",
    starts_at: options.startsAt ?? new Date(Date.now() - 60_000).toISOString(),
    expires_at: options.expiresAt ?? null,
    caps_json: options.caps ?? { writes: 100, reads: 1000, embeds: 100 },
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  expect(inserted.error).toBeNull();
}

describe("PayU hash construction", () => {
  it("builds request hash with fixed field order and blank udf slots", async () => {
    const input = buildPayURequestHashInput({
      key: "payu_key",
      txnid: "txn_fixture_001",
      amount: "499.00",
      productinfo: "MemoryNode Platform",
      firstname: "Memory",
      email: "memory@example.com",
      udf1: "ws_fixture",
      udf2: "deploy",
      udf3: "",
      udf4: "",
      udf5: "",
      salt: "payu_salt",
    });
    expect(input).toBe("payu_key|txn_fixture_001|499.00|MemoryNode Platform|Memory|memory@example.com|ws_fixture|deploy|||||||||payu_salt");
    const hash = await computeSha512Hex(input);
    expect(hash).toBe("c1ca466b7a792259c92d6a8f20640a24f7279a4f5ea284326ff470163f270d666c9c66221fb46c41956474e48726480ef22f5095e7dffd3a45b31dba449a82c5");
  });

  it("builds reverse response hash using salt|status||||||udf5..udf1 order", async () => {
    const payload = {
      status: "success",
      udf5: "u5",
      udf4: "u4",
      udf3: "u3",
      udf2: "u2",
      udf1: "ws_fixture",
      email: "memory@example.com",
      firstname: "Memory",
      productinfo: "MemoryNode Platform",
      amount: "499.00",
      txnid: "txn_fixture_001",
    };
    const input = buildPayUResponseReverseHashInput(payload, {
      PAYU_MERCHANT_KEY: "payu_key",
      PAYU_MERCHANT_SALT: "payu_salt",
    });
    expect(input).toBe("payu_salt|success||||||u5|u4|u3|u2|ws_fixture|memory@example.com|Memory|MemoryNode Platform|499.00|txn_fixture_001|payu_key");
    const hash = await computeSha512Hex(input);
    expect(hash).toBe("af95c234c6650ab03c4cb88c7b28a2413bfdc43067554cba9ad4e304cba21bcc6f2ca78a344a63d657b7a61a6e3e03fab1288116bfe7969083312432d9782865");
  });
});

describe("billing status", () => {
  it("returns billing status for workspace", async () => {
    const req = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_test" },
    });

    const res = await handleBillingStatus(req, makeEnv(), makeSupabase({ plan: "pro", plan_status: "trialing" }) as SupabaseClient, {});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.plan).toBe("pro");
    expect(json.plan_status).toBe("trialing");
    expect(json.cancel_at_period_end).toBe(false);
  });

  it("fails gracefully when PayU env is missing", async () => {
    const req = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_test" },
    });

    const res = await handleBillingStatus(
      req,
      makeEnv({ ENVIRONMENT: "production", PAYU_MERCHANT_KEY: undefined, PAYU_MERCHANT_SALT: undefined, PAYU_BASE_URL: undefined, PUBLIC_APP_URL: undefined }),
      makeSupabase({ plan: "pro", plan_status: "active" }) as SupabaseClient,
      {},
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.code).toBe("BILLING_NOT_CONFIGURED");
    expect(String(json.error.message)).toContain("Missing PayU configuration");
  });
});

describe("non-billing endpoints without PayU config", () => {
  it("usage endpoint still works when PayU vars are missing", async () => {
    const req = new Request("http://localhost/v1/usage/today", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_test" },
    });
    const res = await handleUsageToday(
      req,
      makeEnv({
        PAYU_MERCHANT_KEY: undefined,
        PAYU_MERCHANT_SALT: undefined,
        PAYU_BASE_URL: undefined,
        PUBLIC_APP_URL: undefined,
      }),
      makeSupabase() as SupabaseClient,
      {},
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.writes).toBeDefined();
  });
});

describe("billing checkout + portal", () => {
  it("returns PayU checkout payload and stores txn id", async () => {
    const supabase = makeSupabase({ plan: "free", plan_status: "free" });

    const res = await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test" },
      }),
      makeEnv(),
      supabase as SupabaseClient,
      {},
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.provider).toBe("payu");
    expect(json.method).toBe("POST");
    expect(json.url).toContain("payu");
    expect(json.fields).toBeTruthy();
    expect(typeof json.fields.hash).toBe("string");
    expect(supabase.workspace.payu_txn_id).toMatch(/^mn/);
    const txn = supabase.getTransactionRow(String(supabase.workspace.payu_txn_id));
    expect(txn?.status).toBe("initiated");
    expect(txn?.amount).toBe("499.00");
    expect(txn?.currency).toBe("INR");
  });

  it("rejects pro/team and accepts only launch|build|deploy|scale|scale_plus", async () => {
    const res = await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ plan: "team" }),
      }),
      makeEnv(),
      makeSupabase() as SupabaseClient,
      {},
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("PLAN_NOT_SUPPORTED");
  });

  it("portal endpoint is gone", async () => {
    const res = await handleBillingPortal(
      new Request("http://localhost/v1/billing/portal", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test" },
      }),
      makeEnv(),
      makeSupabase(),
      {},
    );
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error.code).toBe("GONE");
  });
});

describe("billing webhook", () => {
  it("valid response hash passes signature verification", async () => {
    const env = makeEnv();
    const payload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_hash_valid_1",
      mihpayid: "mih_hash_valid_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
      udf2: "pro",
      udf3: "",
      udf4: "",
      udf5: "",
    } as Record<string, string>;
    payload.hash = signPayUWebhook(payload, env);
    const supabase = makeSupabase();
    seedPayUTransaction(supabase, { txnId: payload.txnid, workspaceId: "ws1" });
    mockPayUVerifyApi("success");

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      supabase as SupabaseClient,
      "req-hash-valid",
    );

    expect(res.status).toBe(200);
  });

  it("rejects invalid signature", async () => {
    const payload = {
      key: "payu_key",
      txnid: "txn_bad_sig",
      mihpayid: "mih_bad_sig",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
      hash: "invalid",
    };

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      makeEnv(),
      makeSupabase() as SupabaseClient,
      "req-sig",
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { request_id?: string; error: { code: string } };
    expect(json.error.code).toBe("invalid_webhook_signature");
    expect(json.request_id).toBe("req-sig");
  });

  it("updates workspace on successful payment", async () => {
    const env = makeEnv();
    const payload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_success_1",
      mihpayid: "mihpay_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
      udf2: "pro",
      udf3: "",
      udf4: "",
      udf5: "",
    } as Record<string, string>;
    payload.hash = signPayUWebhook(payload, env);

    const supabase = makeSupabase();
    seedPayUTransaction(supabase, { txnId: "txn_success_1" });
    mockPayUVerifyApi("success", { paymentId: "mihpay_1" });
    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      supabase,
      "req-ok",
    );

    expect(res.status).toBe(200);
    expect(supabase.workspace.plan).toBe("pro");
    expect(supabase.workspace.plan_status).toBe("active");
    expect(supabase.workspace.payu_txn_id).toBe("txn_success_1");
    expect(supabase.workspace.payu_payment_id).toBe("mihpay_1");
    expect(supabase.workspace.payu_last_status).toBe("success");
    expect(supabase.getTransactionRow("txn_success_1")?.status).toBe("success");
    expect(supabase.getEntitlementByTxn("txn_success_1")?.status).toBe("active");
  });

  it("does not grant entitlements when callback says success but verify API returns failure", async () => {
    const env = makeEnv();
    const payload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_verify_fail_1",
      mihpayid: "mih_verify_fail_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
      udf2: "pro",
      udf3: "",
      udf4: "",
      udf5: "",
    } as Record<string, string>;
    payload.hash = signPayUWebhook(payload, env);

    const supabase = makeSupabase({ plan: "free", plan_status: "free" });
    seedPayUTransaction(supabase, { txnId: "txn_verify_fail_1", workspaceId: "ws1" });
    mockPayUVerifyApi("failure", { paymentId: "mih_verify_fail_1" });

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      supabase,
      "req-verify-fail",
    );

    expect(res.status).toBe(200);
    expect(supabase.workspace.plan).toBe("free");
    expect(supabase.workspace.plan_status).toBe("past_due");
    expect(supabase.getEntitlementByTxn("txn_verify_fail_1")).toBeUndefined();
    expect(supabase.getTransactionRow("txn_verify_fail_1")?.status).toBe("verify_failed");
  });

  it("grants entitlements only after verify API confirms success", async () => {
    const env = makeEnv();
    const payload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_verify_success_1",
      mihpayid: "mih_verify_success_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
      udf2: "pro",
      udf3: "",
      udf4: "",
      udf5: "",
    } as Record<string, string>;
    payload.hash = signPayUWebhook(payload, env);

    const supabase = makeSupabase({ plan: "free", plan_status: "free" });
    seedPayUTransaction(supabase, { txnId: "txn_verify_success_1", workspaceId: "ws1" });
    mockPayUVerifyApi("success", { paymentId: "mih_verify_success_1" });

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      supabase,
      "req-verify-success",
    );

    expect(res.status).toBe(200);
    expect(supabase.workspace.plan).toBe("pro");
    expect(supabase.workspace.plan_status).toBe("active");
    expect(supabase.getTransactionRow("txn_verify_success_1")?.status).toBe("success");
    expect(supabase.getEntitlementByTxn("txn_verify_success_1")?.status).toBe("active");
  });

  it("treats replayed webhook event ids as no-op", async () => {
    const env = makeEnv();
    const payload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_replay_1",
      mihpayid: "mihpay_replay_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
      udf2: "pro",
      udf3: "",
      udf4: "",
      udf5: "",
    } as Record<string, string>;
    payload.hash = signPayUWebhook(payload, env);

    const supabase = makeSupabase();
    seedPayUTransaction(supabase, { txnId: "txn_replay_1", workspaceId: "ws1" });
    mockPayUVerifyApi("success", { paymentId: "mihpay_replay_1" });
    const req = () =>
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    const first = await handleBillingWebhook(req(), env, supabase, "req-replay-1");
    const second = await handleBillingWebhook(req(), env, supabase, "req-replay-2");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(supabase.workspace.payu_last_event_id).toBe("mihpay_replay_1");
    expect(supabase.getBillingUpdateCount()).toBe(1);
    expect(supabase.getEntitlementByTxn("txn_replay_1")?.status).toBe("active");
  });

  it("keeps transaction state monotonic and safe on replay with changed verify outcome", async () => {
    const env = makeEnv();
    const supabase = makeSupabase({ plan: "free", plan_status: "free" });
    seedPayUTransaction(supabase, { txnId: "txn_mono_1", workspaceId: "ws1" });

    const successPayload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_mono_1",
      mihpayid: "mih_mono_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
      udf2: "pro",
      addedon: "2026-02-13T10:00:00Z",
    } as Record<string, string>;
    successPayload.hash = signPayUWebhook(successPayload, env);

    mockPayUVerifyApi("success", { paymentId: "mih_mono_1" });
    const first = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(successPayload),
      }),
      env,
      supabase,
      "req-mono-1",
    );
    expect(first.status).toBe(200);
    expect(supabase.getTransactionRow("txn_mono_1")?.status).toBe("success");

    const failurePayload = {
      ...successPayload,
      mihpayid: "mih_mono_2",
      status: "failure",
      addedon: "2026-02-13T10:01:00Z",
    };
    failurePayload.hash = signPayUWebhook(failurePayload, env);

    mockPayUVerifyApi("failure", { paymentId: "mih_mono_2" });
    const second = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(failurePayload),
      }),
      env,
      supabase,
      "req-mono-2",
    );
    expect(second.status).toBe(200);
    expect(supabase.getTransactionRow("txn_mono_1")?.status).toBe("success");
    expect(supabase.workspace.plan).toBe("pro");
    expect(supabase.workspace.plan_status).toBe("active");
  });

  it("stores workspace-missing webhook as deferred", async () => {
    const env = makeEnv();
    const payload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_deferred_1",
      mihpayid: "mihpay_deferred_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform",
      firstname: "MemoryNode",
      email: "missing@example.com",
      udf1: "ws-missing",
    } as Record<string, string>;
    payload.hash = signPayUWebhook(payload, env);

    const supabase = makeSupabase();
    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      supabase,
      "req-deferred",
    );

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.error.code).toBe("webhook_deferred");
    expect(supabase.getWebhookRow("mihpay_deferred_1")?.status).toBe("deferred");
  });
});

describe("cap enforcement upgrade path", () => {
  it("returns 402 with upgrade info and effective plan", async () => {
    const usageAtCap = { writes: 0, reads: capsByPlan.free.reads, embeds: capsByPlan.free.embeds };
    const supabase = makeSupabase({
      plan: "pro",
      plan_status: "past_due",
      usage: usageAtCap,
    });

    const res = await handleSearch(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", query: "hello" }),
      }),
      makeEnv({ PUBLIC_APP_URL: "https://app.example.com" }) as Record<string, unknown>,
      supabase,
      {},
    );

    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.code).toBe("CAP_EXCEEDED");
    expect(json.error.upgrade_required).toBe(true);
    expect(json.error.effective_plan).toBe("free");
    expect(json.error.upgrade_url).toContain("/settings/billing");
  });

  it("memories cap uses effective plan when past_due", async () => {
    const usageAtCap = {
      writes: capsByPlan.free.writes,
      reads: capsByPlan.free.reads,
      embeds: capsByPlan.free.embeds,
    };
    const supabase = makeSupabase({
      plan: "pro",
      plan_status: "past_due",
      usage: usageAtCap,
    });

    const res = await handleCreateMemory(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: {
          authorization: "Bearer mn_live_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ user_id: "u1", text: "hello world" }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase as SupabaseClient,
      {},
    );

    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.code).toBe("CAP_EXCEEDED");
    expect(json.error.upgrade_required).toBe(true);
    expect(json.error.effective_plan).toBe("free");
  });

  it("context cap uses effective plan when canceled", async () => {
    const usageAtCap = { writes: 0, reads: capsByPlan.free.reads, embeds: capsByPlan.free.embeds };
    const supabase = makeSupabase({
      plan: "pro",
      plan_status: "canceled",
      usage: usageAtCap,
    });

    const res = await handleContext(
      new Request("http://localhost/v1/context", {
        method: "POST",
        headers: {
          authorization: "Bearer mn_live_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ user_id: "u1", query: "hello" }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase as SupabaseClient,
      {},
    );

    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.code).toBe("CAP_EXCEEDED");
    expect(json.error.upgrade_required).toBe(true);
    expect(json.error.effective_plan).toBe("free");
  });

  it("blocks quota-consuming routes when entitlement is expired", async () => {
    const supabase = makeSupabase({
      plan: "pro",
      plan_status: "active",
      usage: { writes: 0, reads: 0, embeds: 0 },
    });
    seedEntitlement(supabase, {
      workspaceId: "ws1",
      txnId: "txn_expired_1",
      status: "active",
      startsAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      caps: { writes: 999, reads: 999, embeds: 999 },
    });

    const res = await handleSearch(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", query: "hello" }),
      }),
      makeEnv({ PUBLIC_APP_URL: "https://app.example.com" }) as Record<string, unknown>,
      supabase,
      {},
    );

    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.code).toBe("ENTITLEMENT_EXPIRED");
    expect(json.error.upgrade_required).toBe(true);
    expect(json.error.effective_plan).toBe("free");
    expect(typeof json.error.expired_at).toBe("string");
  });
});

describe("admin billing health", () => {
  it("returns PayU config/db probe and recent billing rows without exposing secrets", async () => {
    const supabase = makeSupabase();
    const now = new Date().toISOString();
    const txnInsert = supabase.from("payu_transactions").insert({
      txn_id: "txn_health_1",
      workspace_id: "ws1",
      plan_code: "pro",
      amount: "49.00",
      currency: "INR",
      status: "success",
      verify_status: "success",
      updated_at: now,
    });
    expect(txnInsert.error).toBeNull();

    const webhookInsert = await supabase
      .from("payu_webhook_events")
      .insert({
        event_id: "mih_health_1",
        status: "processed",
        payu_status: "success",
        event_created: Math.floor(Date.now() / 1000),
      })
      .select()
      .single();
    expect(webhookInsert.error).toBeNull();

    const res = await handleAdminBillingHealth(
      new Request("http://localhost/v1/admin/billing/health", {
        method: "GET",
        headers: { "x-admin-token": "admin" },
      }),
      makeEnv({ MASTER_ADMIN_TOKEN: "admin", PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice?form=2" }),
      supabase as SupabaseClient,
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.payu_verify.configured).toBe(true);
    expect(json.payu_verify.host).toBe("info.payu.in");
    expect(json.db_connectivity.ok).toBe(true);
    expect(Array.isArray(json.payu_webhook_events.items)).toBe(true);
    expect(Array.isArray(json.payu_transactions.items)).toBe(true);
    expect(String(JSON.stringify(json))).not.toContain("payu_salt");
    expect(String(JSON.stringify(json))).not.toContain("payu_key");
  });

  it("requires a valid admin token", async () => {
    await expect(
      handleAdminBillingHealth(
        new Request("http://localhost/v1/admin/billing/health", { method: "GET" }),
        makeEnv({ MASTER_ADMIN_TOKEN: "admin" }),
        makeSupabase() as SupabaseClient,
      ),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });
});

describe("billing endpoint auth", () => {
  it("checkout requires API key", async () => {
    await expect(
      handleBillingCheckout(
        new Request("http://localhost/v1/billing/checkout", { method: "POST" }),
        makeEnv() as Record<string, unknown>,
        makeSupabase() as SupabaseClient,
        {},
      ),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  it("portal requires API key", async () => {
    await expect(
      handleBillingPortal(
        new Request("http://localhost/v1/billing/portal", { method: "POST" }),
        makeEnv() as Record<string, unknown>,
        makeSupabase() as SupabaseClient,
        {},
      ),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  it("webhook skips API auth but enforces signature", async () => {
    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
      makeEnv() as Record<string, unknown>,
      makeSupabase(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("BAD_REQUEST");
  });
});
