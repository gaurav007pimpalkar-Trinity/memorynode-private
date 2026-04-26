import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/workerApp.js";
import {
  buildControlPlaneProxyHeaders,
  resolveControlPlaneUpstreamTargetUrl,
} from "../src/controlPlaneProxy.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateDo = makeRateLimitDoStub();

describe("controlPlaneProxy helpers", () => {
  it("preserves pathname and query on upstream URL", () => {
    const req = new Request("https://api.example/v1/admin/founder/phase1?range=7d");
    expect(resolveControlPlaneUpstreamTargetUrl(req, "https://cp.example")).toBe(
      "https://cp.example/v1/admin/founder/phase1?range=7d",
    );
  });

  it("overwrites client IP header from trusted ingress (cf-connecting-ip)", () => {
    const req = new Request("http://127.0.0.1/v1/admin/billing/health", {
      headers: {
        "x-admin-token": "tok",
        "cf-connecting-ip": "203.0.113.9",
        "x-memorynode-proxy-client-ip": "6.6.6.6",
      },
    });
    const h = buildControlPlaneProxyHeaders(req, "sec");
    expect(h.get("x-internal-secret")).toBe("sec");
    expect(h.get("x-admin-token")).toBe("tok");
    expect(h.get("x-memorynode-proxy-client-ip")).toBe("203.0.113.9");
  });
});

function makeCircuitBreakerDoStubCircuitOpen() {
  return {
    idFromName: vi.fn(() => ({})),
    get: vi.fn(() => ({
      fetch: vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
        if (body.action === "isOpen") {
          return new Response(JSON.stringify({ open: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    })),
  };
}

describe("public API /v1/admin/* proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseEnv = {
    RATE_LIMIT_DO: rateDo,
    SUPABASE_URL: "http://localhost",
    SUPABASE_SERVICE_ROLE_KEY: "srk",
    OPENAI_API_KEY: "k",
    API_KEY_SALT: "s",
    MASTER_ADMIN_TOKEN: "admin-token-123",
    ENVIRONMENT: "dev",
    CONTROL_PLANE_ORIGIN: "https://cp.test",
    CONTROL_PLANE_SECRET: "internal-secret-32chars-long!!!!",
  };

  it("returns 401 and does not fetch upstream when admin token is invalid", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/admin/founder/phase1?range=7d", {
        headers: { "x-admin-token": "wrong" },
      }),
      baseEnv as never,
    );
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards to CONTROL_PLANE_ORIGIN with x-internal-secret after requireAdmin", async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://cp.test/v1/admin/founder/phase1?range=7d");
      const h = init?.headers;
      expect(h).toBeInstanceOf(Headers);
      const headers = h as Headers;
      expect(headers.get("x-internal-secret")).toBe("internal-secret-32chars-long!!!!");
      expect(headers.get("x-admin-token")).toBe("admin-token-123");
      return new Response(JSON.stringify({ proxied: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/admin/founder/phase1?range=7d", {
        headers: { "x-admin-token": "admin-token-123" },
      }),
      baseEnv as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proxied: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when CONTROL_PLANE_ORIGIN is unset", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/admin/founder/phase1?range=7d", {
        headers: { "x-admin-token": "admin-token-123" },
      }),
      { ...baseEnv, CONTROL_PLANE_ORIGIN: "" } as never,
    );
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 503 when control-plane proxy circuit is open (does not call upstream)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleRequest(
      new Request("http://127.0.0.1:8787/v1/admin/founder/phase1?range=7d", {
        headers: { "x-admin-token": "admin-token-123" },
      }),
      { ...baseEnv, CIRCUIT_BREAKER_DO: makeCircuitBreakerDoStubCircuitOpen() } as never,
    );
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("SERVICE_UNAVAILABLE");
  });
});
