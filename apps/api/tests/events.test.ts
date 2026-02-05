import { describe, expect, it, beforeEach } from "vitest";
import { handleCreateMemory, handleSearch, handleBillingCheckout, handleBillingWebhook } from "../src/index.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";

const stripeMocks = {
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  billingPortal: { sessions: { create: vi.fn() } },
  webhooks: { constructEvent: vi.fn() },
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
      constructor() {}
    },
  };
});

type EventRow = {
  event_name: string;
  workspace_id: string;
};

type SupabaseMock = SupabaseClient & { events: EventRow[] };

function makeSupabase(options?: {
  plan_status?: "free" | "trialing" | "active" | "past_due" | "canceled";
  usage?: { writes: number; reads: number; embeds: number };
  subscriptionStatus?: string;
}): SupabaseMock {
  const events: EventRow[] = [];
  const usage = options?.usage ?? { writes: 0, reads: 0, embeds: 0 };
  const planStatus = options?.plan_status ?? "free";
  const workspaceRow = { id: "ws1", plan_status: planStatus };
  const stripeEvents: string[] = [];

  return {
    events,
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
            data: { id: "k1", workspace_id: "ws1", workspaces: { plan: "pro", plan_status: planStatus } },
            error: null,
          }),
        };
        return { select: () => builder };
      }
      if (table === "workspaces") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: workspaceRow, error: null }),
          single: async () => ({ data: workspaceRow, error: null }),
          update: () => ({ eq: () => ({ data: [workspaceRow], error: null }) }),
        };
        return builder;
      }
      if (table === "product_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: events.find((e) => e.event_name), error: null }),
                }),
              }),
            }),
          }),
          insert: (rows: Array<{ event_name: string; workspace_id: string }> | { event_name: string; workspace_id: string }) => {
            const list = Array.isArray(rows) ? rows : [rows];
            list.forEach((r) => events.push({ event_name: r.event_name, workspace_id: r.workspace_id }));
            return { error: null };
          },
        };
      }
      if (table === "stripe_webhook_events") {
        return {
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
            const { event_id } = list[0];
            if (stripeEvents.includes(event_id)) {
              return { data: null, error: { code: "23505", message: "duplicate" } };
            }
            stripeEvents.push(event_id);
            return {
              select: () => ({
                maybeSingle: async () => ({ data: { event_id }, error: null }),
              }),
            };
          },
        };
      }
      if (table === "usage_daily") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: usage, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "memories") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "m1" }, error: null }) }) }),
        };
      }
      if (table === "memory_chunks") {
        return { insert: () => ({ error: null }) };
      }
      return { rpc: () => ({ data: [], error: null }) };
    },
    rpc(name: string) {
      if (name === "bump_usage") return { data: { writes: usage.writes, reads: usage.reads, embeds: usage.embeds }, error: null };
      return { data: [], error: null };
    },
  } as unknown as SupabaseMock;
}

beforeEach(() => {
  stripeMocks.customers.create.mockReset();
  stripeMocks.checkout.sessions.create.mockReset();
  stripeMocks.billingPortal.sessions.create.mockReset();
  stripeMocks.webhooks.constructEvent.mockReset();
});

describe("product events", () => {
const env = {
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OPENAI_API_KEY: "",
  API_KEY_SALT: "salt",
  MASTER_ADMIN_TOKEN: "",
  RATE_LIMIT_DO: {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () =>
        new Response(JSON.stringify({ allowed: true, count: 0, reset: Math.floor(Date.now() / 1000) + 60, limit: 100 })),
    }),
  },
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec",
  STRIPE_PRICE_PRO: "price_123",
  PUBLIC_APP_URL: "https://app.example.com",
  EMBEDDINGS_MODE: "stub",
} as Record<string, unknown>;

  it("emits first_ingest_success only once", async () => {
    const supabase = makeSupabase({ usage: { writes: 0, reads: 0, embeds: 0 } });
    const req = new Request("http://localhost/v1/memories", {
      method: "POST",
      headers: { authorization: "Bearer mn_live_x", "content-type": "application/json" },
      body: JSON.stringify({ user_id: "u1", text: "hello" }),
    });
    await handleCreateMemory(req, env, supabase, {}, "req-1");
    await handleCreateMemory(req, env, supabase, {}, "req-2");
    const first = supabase.events.filter((e: EventRow) => e.event_name === "first_ingest_success");
    expect(first.length).toBe(1);
  });

  it("emits cap_exceeded when usage over limit", async () => {
    const supabase = makeSupabase({ usage: { writes: 0, reads: 5000, embeds: 0 }, plan_status: "past_due" });
    const req = new Request("http://localhost/v1/search", {
      method: "POST",
      headers: { authorization: "Bearer mn_live_x", "content-type": "application/json" },
      body: JSON.stringify({ user_id: "u1", query: "test" }),
    });
    const res = await handleSearch(req, env, supabase, {}, "req-cap");
    expect(res.status).toBe(402);
    const cap = supabase.events.find((e: EventRow) => e.event_name === "cap_exceeded");
    expect(cap).toBeTruthy();
  });

  it("emits checkout_started on checkout", async () => {
    const supabase = makeSupabase();
    stripeMocks.customers.create.mockResolvedValue({ id: "cus_123" });
    stripeMocks.checkout.sessions.create.mockResolvedValue({ url: "https://checkout" });
    const res = await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_x" },
      }),
      env,
      supabase,
      {},
      "req-checkout",
    );
    expect(res.status).toBe(200);
    const evt = supabase.events.find((e: EventRow) => e.event_name === "checkout_started");
    expect(evt).toBeTruthy();
  });

  it("emits upgrade_activated when status becomes active", async () => {
    const supabase = makeSupabase({ plan_status: "free" });
    stripeMocks.webhooks.constructEvent.mockReturnValue({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: "active",
          current_period_end: 1_700_000_000,
          cancel_at_period_end: false,
          metadata: { workspace_id: "ws1" },
          items: { data: [{ price: { id: "price_123" } }] },
        },
      },
    });
    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": "sig" },
        body: "{}",
      }),
      env,
      supabase,
      "req-upgrade",
    );
    expect(res.status).toBe(200);
    const evt = supabase.events.find((e: EventRow) => e.event_name === "upgrade_activated");
    expect(evt).toBeTruthy();
  });
});
