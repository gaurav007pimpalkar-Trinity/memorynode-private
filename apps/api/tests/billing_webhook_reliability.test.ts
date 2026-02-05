import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("stripe", () => {
  const ctor = vi.fn(() => ({
    customers: { create: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn() },
  }));
  ctor.createFetchHttpClient = vi.fn(() => ({}));
  ctor.createSubtleCryptoProvider = vi.fn(() => ({}));
  return { __esModule: true, default: ctor, Stripe: ctor };
});

import { handleBillingWebhook } from "../src/index.js";

const stripeCtor = (await import("stripe")).default as unknown as vi.Mock;
stripeCtor.mockClear();

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
  STRIPE_WEBHOOK_SECRET: "whsec_123",
  STRIPE_PRICE_PRO: "price_123",
  PUBLIC_APP_URL: "https://app.example.com",
  SUPABASE_MODE: "stub",
} as Record<string, unknown>;

function makeSupabase(workspaceExists: boolean): SupabaseClient {
  const workspaceRow = workspaceExists
    ? { id: "ws1", plan: "free", plan_status: "free" }
    : null;
  const stripeEvents: string[] = [];
  const stripeWebhookBuilder = {
    select: () => ({
      eq: (_col: string, val: unknown) => ({
        maybeSingle: async () => ({
          data: stripeEvents.includes(val as string) ? { event_id: val } : null,
          error: null,
        }),
      }),
    }),
    insert: (rows: Array<{ event_id: string }> | { event_id: string }) => {
      const list = Array.isArray(rows) ? rows : [rows];
      const row = list[0];
      if (stripeEvents.includes(row.event_id)) {
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      stripeEvents.push(row.event_id);
      return {
        select: () => ({
          maybeSingle: async () => ({ data: { event_id: row.event_id }, error: null }),
        }),
      };
    },
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
  stripeCtor.mockClear();
});

describe("Stripe webhook reliability", () => {
  it("passes raw bytes to Stripe signature verification", async () => {
    const body = new TextEncoder().encode('{"hello":"world"}');
    const req = new Request("http://localhost/v1/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=fake" },
      body,
    });

    // Make constructEvent return a benign event
    stripeCtor.mockReturnValueOnce({
      customers: { create: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: {
        constructEvent: vi.fn().mockReturnValue({
          type: "invoice.paid",
          data: { object: { customer: "cus_123" } },
        }),
      },
    });

    const res = await handleBillingWebhook(req, baseEnv as Record<string, unknown>, makeSupabase(false), "req-raw");
    expect(res.status).toBe(200);

    const instance = stripeCtor.mock.results.at(-1)?.value;
    expect(instance.webhooks.constructEvent).toHaveBeenCalledTimes(1);
    const [raw] = instance.webhooks.constructEvent.mock.calls[0];
    expect(typeof raw).toBe("string");
    expect(raw).toBe('{"hello":"world"}');
  });

  it("returns 200 when workspace is not found by customer or metadata", async () => {
    const eventObj = {
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
    stripeCtor.mockReturnValueOnce({
      customers: { create: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: {
        constructEvent: vi.fn().mockReturnValue(eventObj),
      },
    });

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

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ received: true });
  });

  it("logs only redacted fields and no sensitive payload data", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const eventObj = {
      type: "invoice.payment_failed",
      id: "evt_123",
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

    stripeCtor.mockReturnValueOnce({
      customers: { create: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: {
        constructEvent: vi.fn().mockReturnValue(eventObj),
      },
    });

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=fake" },
        body: "{}",
      }),
      baseEnv as Record<string, unknown>,
      makeSupabase(false),
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
});
