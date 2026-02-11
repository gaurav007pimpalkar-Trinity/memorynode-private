import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const stripeMocks = {
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  billingPortal: { sessions: { create: vi.fn() } },
  webhooks: { constructEvent: vi.fn() },
  subscriptions: { retrieve: vi.fn() },
  invoices: { retrieve: vi.fn() },
  events: { retrieve: vi.fn() },
};

vi.mock("stripe", () => {
  return {
    default: class StripeMock {
      static createFetchHttpClient = vi.fn(() => ({}));
      static createSubtleCryptoProvider = vi.fn(() => ({}));
      customers = stripeMocks.customers;
      checkout = stripeMocks.checkout;
      billingPortal = stripeMocks.billingPortal;
      webhooks = stripeMocks.webhooks;
      subscriptions = stripeMocks.subscriptions;
      invoices = stripeMocks.invoices;
      events = stripeMocks.events;
      constructor() {}
    },
  };
});

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
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "stripe_webhook_secret_test_123",
  STRIPE_PRICE_PRO: "price_123",
  PUBLIC_APP_URL: "https://app.example.com",
  SUPABASE_MODE: "stub",
} as Record<string, unknown>;

function makeSupabase(workspaceExists: boolean): SupabaseClient {
  const workspaceRow = workspaceExists
    ? { id: "ws1", plan: "free", plan_status: "free" }
    : null;
  const stripeEvents = new Map<string, Record<string, unknown>>();
  const stripeWebhookBuilder = {
    select: () => ({
      eq: (_col: string, val: unknown) => ({
        maybeSingle: async () => ({
          data: stripeEvents.get(String(val)) ?? null,
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
            if (stripeEvents.has(String(row.event_id))) {
              return { data: null, error: { code: "23505", message: "duplicate" } };
            }
            stripeEvents.set(String(row.event_id), { ...row });
            return { data: stripeEvents.get(String(row.event_id)) ?? null, error: null };
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
        const existing = stripeEvents.get(key);
        if (existing) Object.assign(existing, fields);
        return { data: existing ? [existing] : [], error: null };
      },
    }),
  };
  const workspacesBuilder = {
    select: () => workspacesBuilder,
    eq: () => workspacesBuilder,
    maybeSingle: async () => ({ data: workspaceRow, error: null }),
    single: async () => ({ data: workspaceRow, error: null }),
    update: () => ({ eq: () => ({ data: workspaceRow ? [workspaceRow] : [], error: null }) }),
  };
  return {
    from(table: string) {
      if (table === "workspaces") return workspacesBuilder;
      if (table === "stripe_webhook_events") return stripeWebhookBuilder;
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

afterEach(() => {
  vi.restoreAllMocks();
  stripeMocks.customers.create.mockReset();
  stripeMocks.checkout.sessions.create.mockReset();
  stripeMocks.billingPortal.sessions.create.mockReset();
  stripeMocks.webhooks.constructEvent.mockReset();
  stripeMocks.subscriptions.retrieve.mockReset();
  stripeMocks.invoices.retrieve.mockReset();
  stripeMocks.events.retrieve.mockReset();
});

describe("Stripe webhook reliability", () => {
  it("passes raw bytes to Stripe signature verification", async () => {
    const body = new TextEncoder().encode('{"hello":"world"}');
    const req = new Request("http://localhost/v1/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=fake" },
      body,
    });

    stripeMocks.webhooks.constructEvent.mockReturnValue({
      id: "evt_raw",
      created: 1_700_000_100,
      type: "invoice.paid",
      data: { object: { customer: "cus_123" } },
    });

    const res = await handleBillingWebhook(req, baseEnv as Record<string, unknown>, makeSupabase(true), "req-raw");
    expect(res.status).toBe(200);

    expect(stripeMocks.webhooks.constructEvent).toHaveBeenCalledTimes(1);
    const [raw] = stripeMocks.webhooks.constructEvent.mock.calls[0];
    expect(typeof raw).toBe("string");
    expect(raw).toBe('{"hello":"world"}');
    const tolerance = stripeMocks.webhooks.constructEvent.mock.calls[0][3] as number;
    expect(tolerance).toBe(300);
  });

  it("returns 202 deferred when workspace is not found by customer or metadata", async () => {
    const eventObj = {
      id: "evt_missing_workspace",
      created: 1_700_000_200,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_missing",
          customer: "cus_missing",
          status: "active",
          metadata: { workspace_id: "ws_missing" },
          current_period_end: 0,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: "price_123" } }] },
        },
      },
    };
    stripeMocks.webhooks.constructEvent.mockReturnValue(eventObj);

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=fake" },
        body: "{}",
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const eventObj = {
      type: "invoice.payment_failed",
      id: "evt_123",
      created: 1_700_000_300,
      data: {
        object: {
          customer: "cus_sensitive",
          metadata: { workspace_id: "ws_sensitive" },
          lines: { data: [{ card: "4111", client_secret: "secret" }] },
          customer_email: "user@example.com",
          invoice_pdf: "https://stripe.com/pdf",
        },
      },
    };

    stripeMocks.webhooks.constructEvent.mockReturnValue(eventObj);

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=fake" },
        body: "{}",
      }),
      baseEnv as Record<string, unknown>,
      makeSupabase(true),
    );

    expect(res.status).toBe(200);
    const combinedLogs = [...warnSpy.mock.calls, ...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((args) => JSON.stringify(args))
      .join(" ");
    const forbidden = ["card", "client_secret", "invoice_pdf", "customer_email", "lines"];
    for (const token of forbidden) {
      expect(combinedLogs.toLowerCase()).not.toContain(token);
    }
    warnSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("allows tolerance override from env", async () => {
    stripeMocks.webhooks.constructEvent.mockReturnValue({
      id: "evt_tolerance",
      created: 1_700_000_400,
      type: "invoice.paid",
      data: { object: { customer: "cus_123" } },
    });

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=fake" },
        body: "{}",
      }),
      { ...baseEnv, STRIPE_WEBHOOK_TOLERANCE_SEC: "120" } as Record<string, unknown>,
      makeSupabase(true),
      "req-tolerance",
    );
    expect(res.status).toBe(200);
    expect(stripeMocks.webhooks.constructEvent).toHaveBeenCalledTimes(1);
    expect(stripeMocks.webhooks.constructEvent.mock.calls[0][3]).toBe(120);
  });

  it("emits webhook_processed then webhook_replayed for duplicate event ids", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stripeMocks.webhooks.constructEvent.mockReturnValue({
      id: "evt_replay_log",
      created: 1_700_000_500,
      type: "invoice.paid",
      data: { object: { customer: "cus_123" } },
    });

    const makeReq = () =>
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=fake" },
        body: "{}",
      });
    const supabase = makeSupabase(true);
    const first = await handleBillingWebhook(makeReq(), baseEnv as Record<string, unknown>, supabase, "req-log-1");
    const second = await handleBillingWebhook(makeReq(), baseEnv as Record<string, unknown>, supabase, "req-log-2");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const lines = logSpy.mock.calls
      .map((args) => args[0])
      .filter((line) => typeof line === "string")
      .map((line) => {
        try {
          return JSON.parse(line as string) as { event_name?: string };
        } catch {
          return {};
        }
      });
    const names = lines.map((line) => line.event_name);
    expect(names).toContain("webhook_processed");
    expect(names).toContain("webhook_replayed");
    logSpy.mockRestore();
  });
});
