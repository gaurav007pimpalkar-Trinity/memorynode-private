import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleBillingStatus,
  handleBillingCheckout,
  handleBillingPortal,
  handleBillingWebhook,
  handleUsageToday,
  handleSearch,
  handleCreateMemory,
  handleContext,
} from "../src/index.js";
import { capsByPlan } from "../src/limits.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateLimitDo = makeRateLimitDoStub();

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

beforeEach(() => {
  stripeMocks.customers.create.mockReset();
  stripeMocks.checkout.sessions.create.mockReset();
  stripeMocks.billingPortal.sessions.create.mockReset();
  stripeMocks.webhooks.constructEvent.mockReset();
});

type WorkspaceRow = {
  id: string;
  plan: "free" | "pro" | "team";
  plan_status: "free" | "trialing" | "active" | "past_due" | "canceled";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

function makeSupabase(options?: {
  plan?: WorkspaceRow["plan"];
  plan_status?: WorkspaceRow["plan_status"];
  workspace?: Partial<WorkspaceRow>;
  usage?: { writes: number; reads: number; embeds: number };
}) {
  const workspace: WorkspaceRow = {
    id: options?.workspace?.id ?? "ws1",
    plan: options?.plan ?? options?.workspace?.plan ?? "free",
    plan_status: options?.plan_status ?? options?.workspace?.plan_status ?? "free",
    stripe_customer_id: options?.workspace?.stripe_customer_id ?? null,
    stripe_subscription_id: options?.workspace?.stripe_subscription_id ?? null,
    stripe_price_id: options?.workspace?.stripe_price_id ?? null,
    current_period_end: options?.workspace?.current_period_end ?? null,
    cancel_at_period_end: options?.workspace?.cancel_at_period_end ?? false,
  };

  const usage = options?.usage ?? { writes: 0, reads: 0, embeds: 0 };
  const stripeEvents: string[] = [];

  return {
    workspace,
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
      throw new Error(`Unexpected table ${table}`);
    },
    rpc() {
      return { data: [], error: null };
    },
  } as unknown as SupabaseClient & { workspace: WorkspaceRow };
}

function makeEnv(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    OPENAI_API_KEY: "",
    API_KEY_SALT: "salt",
    MASTER_ADMIN_TOKEN: "",
    RATE_LIMIT_DO: rateLimitDo,
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec",
    STRIPE_PRICE_PRO: "price_123",
    PUBLIC_APP_URL: "https://app.example.com",
    ...overrides,
  };
}

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

  it("normalizes plan_status and exposes effective_plan", async () => {
    const cases: Array<[string, string, string]> = [
      ["pro", "active", "pro"],
      ["pro", "trialing", "pro"],
      ["pro", "past_due", "free"],
      ["pro", "canceled", "free"],
      ["pro", "weird", "free"],
    ];

    for (const [plan, status, effective] of cases) {
      const res = await handleBillingStatus(
        new Request("http://localhost/v1/billing/status", {
          method: "GET",
          headers: { authorization: "Bearer mn_live_test" },
        }),
        makeEnv(),
        makeSupabase({ plan, plan_status: status as WorkspaceRow["plan_status"] }) as SupabaseClient,
        {},
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.effective_plan).toBe(effective);
    }
  });

  it("uses pro caps when plan_status is active", async () => {
    const res = await handleUsageToday(
      new Request("http://localhost/v1/usage/today", {
        method: "GET",
        headers: { authorization: "Bearer mn_live_test" },
      }),
      makeEnv(),
      makeSupabase({ plan: "pro", plan_status: "active" }) as SupabaseClient,
      {},
    );

    const json = await res.json();
    expect(json.plan).toBe("pro");
    expect(json.limits).toEqual(capsByPlan.pro);
  });

  it("fails gracefully when Stripe env is missing", async () => {
    const req = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_test" },
    });

    const res = await handleBillingStatus(
      req,
      makeEnv({ ENVIRONMENT: "production", STRIPE_SECRET_KEY: undefined, PUBLIC_APP_URL: undefined, STRIPE_PRICE_PRO: undefined }),
      makeSupabase({ plan: "pro", plan_status: "active" }) as SupabaseClient,
      {},
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.code).toBe("BILLING_NOT_CONFIGURED");
    expect(String(json.error.message)).toContain("Missing Stripe configuration");
  });
});

describe("non-billing endpoints without Stripe config", () => {
  it("usage endpoint still works when Stripe vars are missing", async () => {
    const req = new Request("http://localhost/v1/usage/today", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_test" },
    });
    const res = await handleUsageToday(
      req,
      makeEnv({
        STRIPE_SECRET_KEY: undefined,
        STRIPE_WEBHOOK_SECRET: undefined,
        STRIPE_PRICE_PRO: undefined,
        STRIPE_PRICE_TEAM: undefined,
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
  it("creates customer when missing and returns checkout url", async () => {
    stripeMocks.customers.create.mockResolvedValue({ id: "cus_123" });
    stripeMocks.checkout.sessions.create.mockResolvedValue({ url: "https://stripe/checkout" });
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
    expect(stripeMocks.customers.create).toHaveBeenCalled();
    expect(stripeMocks.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_123", quantity: 1 }],
        success_url: "https://app.example.com/settings/billing?status=success",
        cancel_url: "https://app.example.com/settings/billing?status=canceled",
        customer: "cus_123",
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining("mn_checkout:ws1:") }),
    );
    const json = await res.json();
    expect(json.url).toBe("https://stripe/checkout");
    expect(supabase.workspace.stripe_customer_id).toBe("cus_123");
  });

  it("portal returns 409 when customer missing", async () => {
    const supabase = makeSupabase({ workspace: { stripe_customer_id: null } });
    const res = await handleBillingPortal(
      new Request("http://localhost/v1/billing/portal", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test" },
      }),
      makeEnv(),
      supabase,
      {},
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("BILLING_NOT_SETUP");
  });

  it("portal returns url when customer exists", async () => {
    stripeMocks.billingPortal.sessions.create.mockResolvedValue({ url: "https://portal" });
    const supabase = makeSupabase({ workspace: { stripe_customer_id: "cus_123" } });
    const res = await handleBillingPortal(
      new Request("http://localhost/v1/billing/portal", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test" },
      }),
      makeEnv(),
      supabase,
      {},
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.url).toBe("https://portal");
  });

  it("idempotency key is stable per workspace/month and header", async () => {
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    stripeMocks.customers.create.mockResolvedValue({ id: "cus_123" });
    stripeMocks.checkout.sessions.create.mockResolvedValue({ url: "https://stripe/checkout" });
    const supabase = makeSupabase({ plan: "free", plan_status: "free" });

    const reqHeaders = {
      authorization: "Bearer mn_live_test",
      "Idempotency-Key": "client-retry",
    };
    const res1 = await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: reqHeaders,
      }),
      makeEnv(),
      supabase as SupabaseClient,
      {},
    );
    expect(res1.status).toBe(200);
    const idem1 = stripeMocks.checkout.sessions.create.mock.calls.at(-1)?.[1]?.idempotencyKey as string;

    const res2 = await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: reqHeaders,
      }),
      makeEnv(),
      supabase as SupabaseClient,
      {},
    );
    expect(res2.status).toBe(200);
    const idem2 = stripeMocks.checkout.sessions.create.mock.calls.at(-1)?.[1]?.idempotencyKey as string;
    expect(idem1).toBe(idem2);
    expect(idem1).toContain("mn_checkout:ws1:2026-02:");
    vi.useRealTimers();
  });

  it("different header values produce different idempotency suffixes", async () => {
    stripeMocks.customers.create.mockResolvedValue({ id: "cus_123" });
    stripeMocks.checkout.sessions.create.mockResolvedValue({ url: "https://stripe/checkout" });
    const supabase = makeSupabase({ plan: "free", plan_status: "free" });

    await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "Idempotency-Key": "foo" },
      }),
      makeEnv(),
      supabase as SupabaseClient,
      {},
    );
    const keyFoo = stripeMocks.checkout.sessions.create.mock.calls.at(-1)?.[1]?.idempotencyKey as string;

    await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "Idempotency-Key": "bar" },
      }),
      makeEnv(),
      supabase as SupabaseClient,
      {},
    );
    const keyBar = stripeMocks.checkout.sessions.create.mock.calls.at(-1)?.[1]?.idempotencyKey as string;

    expect(keyFoo).not.toBe(keyBar);
  });

  it("different months produce different idempotency keys", async () => {
    stripeMocks.customers.create.mockResolvedValue({ id: "cus_123" });
    stripeMocks.checkout.sessions.create.mockResolvedValue({ url: "https://stripe/checkout" });
    const supabase = makeSupabase({ plan: "free", plan_status: "free" });

    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test" },
      }),
      makeEnv(),
      supabase as SupabaseClient,
      {},
    );
    const febKey = stripeMocks.checkout.sessions.create.mock.calls.at(-1)?.[1]?.idempotencyKey as string;

    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test" },
      }),
      makeEnv(),
      supabase as SupabaseClient,
      {},
    );
    const marKey = stripeMocks.checkout.sessions.create.mock.calls.at(-1)?.[1]?.idempotencyKey as string;

    expect(febKey).not.toBe(marKey);
    vi.useRealTimers();
  });
});

describe("billing webhook", () => {
  const webhookEnv = makeEnv();

  it("rejects invalid signature", async () => {
    stripeMocks.webhooks.constructEvent.mockImplementation(() => {
      throw new Error("bad sig");
    });
    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", { method: "POST", body: "{}" }),
      webhookEnv as Record<string, unknown>,
      makeSupabase() as SupabaseClient,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
  });

  it("updates workspace on subscription update", async () => {
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: "trialing",
          current_period_end: 1_700_000_000,
          cancel_at_period_end: false,
          metadata: { workspace_id: "ws1" },
          items: { data: [{ price: { id: "price_123" } }] },
        },
      },
    } as unknown as Stripe.Event;
    stripeMocks.webhooks.constructEvent.mockReturnValue(event);
    const supabase = makeSupabase({ workspace: { stripe_customer_id: "cus_123" } });

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", { method: "POST", body: "{}" }),
      webhookEnv as Record<string, unknown>,
      supabase,
    );
    expect(res.status).toBe(200);
    expect(supabase.workspace.plan).toBe("pro");
    expect(supabase.workspace.plan_status).toBe("trialing");
    expect(supabase.workspace.stripe_subscription_id).toBe("sub_1");
    expect(supabase.workspace.stripe_price_id).toBe("price_123");
  });

  it("marks workspace past_due on payment failure", async () => {
    const event = {
      type: "invoice.payment_failed",
      data: {
        object: {
          customer: "cus_999",
          metadata: { workspace_id: "ws1" },
        },
      },
    } as unknown as Stripe.Event;
    stripeMocks.webhooks.constructEvent.mockReturnValue(event);
    const supabase = makeSupabase({ workspace: { stripe_customer_id: "cus_999", plan: "pro", plan_status: "active" } });

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", { method: "POST", body: "{}" }),
      webhookEnv as Record<string, unknown>,
      supabase,
    );
    expect(res.status).toBe(200);
    expect(supabase.workspace.plan_status).toBe("past_due");
    expect(supabase.workspace.plan).toBe("free");
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
    expect(json.error.upgrade_url).toContain("/settings/billing");
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
    stripeMocks.webhooks.constructEvent.mockImplementation(() => {
      throw new Error("bad sig");
    });
    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", { method: "POST", body: "{}" }),
      makeEnv() as Record<string, unknown>,
      makeSupabase(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
  });
});
