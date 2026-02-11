import { describe, expect, it } from "vitest";
import { handleBillingStatus } from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RateLimitDO } from "../src/rateLimitDO.js";
import { RATE_LIMIT_WINDOW_MS } from "../src/limits.js";
import { vi } from "vitest";

const envBase = {
  RATE_LIMIT_DO: makeRateLimitDoStub(1), // allow only 1 request per window
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OPENAI_API_KEY: "",
  API_KEY_SALT: "",
  MASTER_ADMIN_TOKEN: "",
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_PRICE_PRO: "price_123",
  PUBLIC_APP_URL: "https://app.example.com",
} as const;

const supabase = {
  from(table: string) {
    if (table === "app_settings") {
      return { select: () => ({ limit: () => ({ single: async () => ({ data: { api_key_salt: "" }, error: null }) }) }) };
    }
    if (table === "api_keys") {
      const builder = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        single: async () => ({
          data: { id: "k1", workspace_id: "ws1", workspaces: { plan: "free", plan_status: "active" } },
          error: null,
        }),
      };
      return builder;
    }
    if (table === "workspaces") {
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({
          data: {
            plan: "free",
            plan_status: "active",
            current_period_end: null,
            cancel_at_period_end: false,
          },
          error: null,
        }),
      };
      return builder;
    }
    if (table === "usage_daily") {
      const builder = {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { writes: 0, reads: 0, embeds: 0 }, error: null }),
            }),
          }),
        }),
      };
      return builder;
    }
    throw new Error(`Unexpected table ${table}`);
  },
};

describe("rate limiting via Durable Object", () => {
  it("blocks after exceeding per-window limit", async () => {
    const req = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_test" },
    });

    const first = await handleBillingStatus(
      req,
      envBase as unknown as Record<string, unknown>,
      supabase as unknown as SupabaseClient,
      {},
    );
    expect(first.status).toBe(200);

    const second = await handleBillingStatus(
      req,
      envBase as unknown as Record<string, unknown>,
      supabase as unknown as SupabaseClient,
      {},
    );
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.error.code).toBe("rate_limited");
  });

  it("fails closed when DO call errors", async () => {
    const env = {
      ...envBase,
      RATE_LIMIT_DO: {
        idFromName: () => "x",
        get: () => ({
          fetch: async () => {
            throw new Error("boom");
          },
        }),
      },
    };

    const req = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_test" },
    });

    await expect(
      handleBillingStatus(req, env as unknown as Record<string, unknown>, supabase as unknown as SupabaseClient, {}),
    ).rejects.toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE", status: 503 });
  });
});

describe("rate limit keying and headers", () => {
  it("uses distinct Durable Object IDs per api key hash", async () => {
    const names: string[] = [];
    const ns = {
      idFromName: (n: string) => {
        names.push(n);
        return n;
      },
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ allowed: true, count: 1, limit: 100, reset: Math.floor(Date.now() / 1000) + 60 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    };

    const env = { ...envBase, RATE_LIMIT_DO: ns };
    const reqA = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_a" },
    });
    const reqB = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_b" },
    });

    await handleBillingStatus(reqA, env as unknown as Record<string, unknown>, supabase as unknown as SupabaseClient, {});
    await handleBillingStatus(reqB, env as unknown as Record<string, unknown>, supabase as unknown as SupabaseClient, {});

    expect(names.length).toBe(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names[0].startsWith("rl:")).toBe(true);
  });

  it("returns retry-after and reset headers when limited", async () => {
    const limiter = makeRateLimitDoStub(1, RATE_LIMIT_WINDOW_MS);
    const env = { ...envBase, RATE_LIMIT_DO: limiter };
    const req = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_a" },
    });

    const first = await handleBillingStatus(req, env as unknown as Record<string, unknown>, supabase as unknown as SupabaseClient, {});
    expect(first.status).toBe(200);

    const second = await handleBillingStatus(req, env as unknown as Record<string, unknown>, supabase as unknown as SupabaseClient, {});
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    const reset = Number(second.headers.get("x-ratelimit-reset"));
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("bypasses rate limit when RATE_LIMIT_MODE=off in dev", async () => {
    const env = { ...envBase, RATE_LIMIT_MODE: "off", RATE_LIMIT_DO: undefined as unknown as DurableObjectNamespace, ENVIRONMENT: "dev" };
    const req = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_a" },
    });

    const first = await handleBillingStatus(req, env as unknown as Record<string, unknown>, supabase as unknown as SupabaseClient, {});
    expect(first.status).toBe(200);
  });
});

describe("RateLimitDO storage window rollover", () => {
  it("overwrites old window bucket instead of growing storage", async () => {
    vi.useFakeTimers();
    const storage = new Map<string, unknown>();
    const state = {
      storage: {
        get: async (k: string) => storage.get(k),
        put: async (k: string, v: unknown) => {
          storage.set(k, v);
        },
        delete: async (k: string) => {
          storage.delete(k);
        },
      },
    } as unknown as DurableObjectState;

    const rl = new RateLimitDO(state);
    vi.setSystemTime(0);
    await rl.fetch(new Request("http://do"));
    expect(storage.size).toBe(1);
    const first = storage.get("bucket") as { windowStart: number; count: number };
    expect(first.count).toBe(1);

    vi.setSystemTime(RATE_LIMIT_WINDOW_MS + 10);
    await rl.fetch(new Request("http://do"));
    expect(storage.size).toBe(1);
    const second = storage.get("bucket") as { windowStart: number; count: number };
    expect(second.windowStart).not.toBe(first.windowStart);
    expect(second.count).toBe(1);
    vi.useRealTimers();
  });

  it("drops stale buckets beyond TTL", async () => {
    vi.useFakeTimers();
    const storage = new Map<string, unknown>();
    const state = {
      storage: {
        get: async (k: string) => storage.get(k),
        put: async (k: string, v: unknown) => storage.set(k, v),
        delete: async (k: string) => {
          storage.delete(k);
        },
      },
    } as unknown as DurableObjectState;

    const rl = new RateLimitDO(state);
    vi.setSystemTime(0);
    await rl.fetch(new Request("http://do"));
    const first = storage.get("bucket") as { windowStart: number; count: number };
    expect(first.count).toBe(1);

    // jump far past two windows to trigger stale cleanup
    vi.setSystemTime(RATE_LIMIT_WINDOW_MS * 3 + 5);
    await rl.fetch(new Request("http://do"));
    const bucket = storage.get("bucket") as { windowStart: number; count: number };
    expect(bucket.windowStart).toBe(Math.floor((RATE_LIMIT_WINDOW_MS * 3 + 5) / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS);
    expect(bucket.count).toBe(1);
    vi.useRealTimers();
  });
});
