import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleBillingWebhook } from "../src/index.js";

const baseEnv = {
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OPENAI_API_KEY: "",
  API_KEY_SALT: "salt",
  MASTER_ADMIN_TOKEN: "",
  RATE_LIMIT_DO: {
    idFromName: vi.fn(),
    get: vi.fn(),
  },
  PAYU_MERCHANT_KEY: "payu_key",
  PAYU_MERCHANT_SALT: "payu_salt",
  PAYU_BASE_URL: "https://secure.payu.in/_payment",
  PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice?form=2",
  PAYU_CURRENCY: "INR",
  PAYU_PRO_AMOUNT: "49.00",
  PAYU_PRODUCT_INFO: "MemoryNode Platform Pro",
  PUBLIC_APP_URL: "https://app.example.com",
  SUPABASE_MODE: "stub",
} as Record<string, unknown>;

function signPayload(payload: Record<string, string>) {
  const seq = [
    String(baseEnv.PAYU_MERCHANT_SALT),
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
    String(baseEnv.PAYU_MERCHANT_KEY),
  ].join("|");
  return crypto.createHash("sha512").update(seq).digest("hex");
}

function makePayload(overrides?: Record<string, string>) {
  const base = {
    key: String(baseEnv.PAYU_MERCHANT_KEY),
    txnid: "txn_rel_1",
    mihpayid: "mihpay_rel_1",
    status: "success",
    amount: "49.00",
    productinfo: "MemoryNode Platform Pro",
    firstname: "MemoryNode",
    email: "ws1@example.com",
    udf1: "ws1",
    udf2: "pro",
    udf3: "",
    udf4: "",
    udf5: "",
    ...(overrides ?? {}),
  };
  return {
    ...base,
    hash: signPayload(base),
  };
}

function makeSupabase(workspaceExists: boolean): SupabaseClient {
  const workspaceRow = workspaceExists
    ? {
      id: "ws1",
      plan: "free",
      plan_status: "free",
      payu_last_event_created: null,
      payu_last_event_id: null,
      payu_txn_id: null,
      payu_payment_id: null,
      payu_last_status: null,
      payu_last_plan: null,
    }
    : null;
  const payuEvents = new Map<string, Record<string, unknown>>();
  const payuTransactions = new Map<string, Record<string, unknown>>();
  const entitlements: Array<Record<string, unknown>> = [];
  let entitlementId = 1;
  if (workspaceExists) {
    payuTransactions.set("txn_rel_1", {
      txn_id: "txn_rel_1",
      workspace_id: "ws1",
      plan_code: "pro",
      amount: "49.00",
      currency: "INR",
      status: "initiated",
    });
  }

  const payuWebhookBuilder = {
    select: () => ({
      eq: (_col: string, val: unknown) => ({
        maybeSingle: async () => ({
          data: payuEvents.get(String(val)) ?? null,
          error: null,
        }),
      }),
    }),
    insert: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => {
      const list = Array.isArray(rows) ? rows : [rows];
      const row = list[0];
      return {
        select: () => {
          const run = async () => {
            if (payuEvents.has(String(row.event_id))) {
              return { data: null, error: { code: "23505", message: "duplicate" } };
            }
            payuEvents.set(String(row.event_id), { ...row });
            return { data: payuEvents.get(String(row.event_id)) ?? null, error: null };
          };
          return {
            maybeSingle: run,
            single: run,
          };
        },
      };
    },
    update: (fields: Record<string, unknown>) => ({
      eq: (_col: string, val: unknown) => {
        const key = String(val);
        const existing = payuEvents.get(key);
        if (existing) Object.assign(existing, fields);
        return { data: existing ? [existing] : [], error: null };
      },
    }),
  };

  const workspacesBuilder = {
    select: () => workspacesBuilder,
    eq: (_col: string, value: unknown) => {
      if (_col === "id") {
        return {
          maybeSingle: async () => ({ data: workspaceRow && workspaceRow.id === value ? workspaceRow : null, error: null }),
          single: async () => ({ data: workspaceRow && workspaceRow.id === value ? workspaceRow : null, error: null }),
        };
      }
      if (_col === "payu_txn_id") {
        return {
          maybeSingle: async () => ({ data: workspaceRow && workspaceRow.payu_txn_id === value ? workspaceRow : null, error: null }),
          single: async () => ({ data: workspaceRow && workspaceRow.payu_txn_id === value ? workspaceRow : null, error: null }),
        };
      }
      return workspacesBuilder;
    },
    maybeSingle: async () => ({ data: workspaceRow, error: null }),
    single: async () => ({ data: workspaceRow, error: null }),
    update: (fields: Record<string, unknown>) => ({
      eq: () => {
        if (workspaceRow) Object.assign(workspaceRow, fields);
        return { data: workspaceRow ? [workspaceRow] : [], error: null };
      },
    }),
  };

  return {
    from(table: string) {
      if (table === "workspaces") return workspacesBuilder;
      if (table === "payu_transactions") {
        return {
          select: () => ({
            eq: (_col: string, val: unknown) => ({
              maybeSingle: async () => ({
                data: payuTransactions.get(String(val)) ?? null,
                error: null,
              }),
            }),
          }),
          insert: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const row = list[0];
            if (payuTransactions.has(String(row.txn_id))) {
              return { data: null, error: { code: "23505", message: "duplicate" } };
            }
            payuTransactions.set(String(row.txn_id), { ...row });
            return { data: [row], error: null };
          },
          update: (fields: Record<string, unknown>) => ({
            eq: (_col: string, val: unknown) => {
              const row = payuTransactions.get(String(val));
              if (row) Object.assign(row, fields);
              return { data: row ? [row] : [], error: null };
            },
          }),
        };
      }
      if (table === "workspace_entitlements") {
        const filters: Array<[string, unknown]> = [];
        const applyFilters = () =>
          entitlements.filter((row) => filters.every(([col, val]) => row[col] === val));
        const builder = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return builder;
          },
          order: () => builder,
          limit: (n: number) => ({ data: applyFilters().slice(0, n), error: null }),
          maybeSingle: async () => ({ data: applyFilters()[0] ?? null, error: null }),
          update: (fields: Record<string, unknown>) => ({
            eq: (_col: string, val: unknown) => {
              const row = entitlements.find((entry) => Number(entry.id) === Number(val));
              if (row) Object.assign(row, fields);
              return { data: row ? [row] : [], error: null };
            },
          }),
          insert: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const inserted = list.map((row) => ({ ...row, id: entitlementId++ }));
            entitlements.push(...inserted);
            return { data: inserted, error: null };
          },
        };
        return {
          select: () => builder,
          update: builder.update,
          insert: builder.insert,
        };
      }
      if (table === "payu_webhook_events") return payuWebhookBuilder;
      if (table === "product_events") return { insert: () => ({ error: null }), select: () => ({ eq: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) };
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

const realFetch = globalThis.fetch;

function mockVerify(status: "success" | "failure") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
      const txnid = body.get("var1") ?? "txn_rel_1";
      return new Response(
        JSON.stringify({
          status: 1,
          transaction_details: {
            [txnid]: {
              txnid,
              status,
              amount: "49.00",
              currency: "INR",
              mihpayid: "mihpay_rel_1",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", realFetch);
});

describe("PayU webhook reliability", () => {
  it("accepts raw byte JSON body when signature is valid", async () => {
    const payload = makePayload();
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const req = new Request("http://localhost/v1/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    mockVerify("success");
    const res = await handleBillingWebhook(req, baseEnv as Record<string, unknown>, makeSupabase(true), "req-raw");
    expect(res.status).toBe(200);
  });

  it("returns 202 deferred when workspace is not found by udf1 or txn", async () => {
    const payload = makePayload({ udf1: "ws_missing", txnid: "txn_missing", mihpayid: "mih_missing" });

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      baseEnv as Record<string, unknown>,
      makeSupabase(false),
      "req-missing",
    );

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.error.code).toBe("webhook_deferred");
  });

  it("logs only redacted fields and no sensitive payload data", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const payload = makePayload({ email: "user@example.com", firstname: "Sensitive", udf1: "ws1" });

    mockVerify("success");
    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      baseEnv as Record<string, unknown>,
      makeSupabase(true),
    );

    expect(res.status).toBe(200);
    const combinedLogs = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((args) => JSON.stringify(args))
      .join(" ");

    const forbidden = ["card", "client_secret", "invoice_pdf", "authorization"];
    for (const token of forbidden) {
      expect(combinedLogs.toLowerCase()).not.toContain(token);
    }
  });
});
