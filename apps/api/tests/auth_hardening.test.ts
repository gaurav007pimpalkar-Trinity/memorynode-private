import { describe, expect, it } from "vitest";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { createHmac } from "node:crypto";
import { assertAdminRequestIpAllowed, rateLimit, requireAdmin } from "../src/auth.js";
import type { Env } from "../src/env.js";

describe("rateLimit fail-closed (staging/production)", () => {
  it("throws 503 when RATE_LIMIT_DO is missing in staging", async () => {
    const env = {
      RATE_LIMIT_MODE: "on",
      ENVIRONMENT: "staging",
      RATE_LIMIT_DO: undefined as unknown as DurableObjectNamespace,
    } as Env;

    await expect(rateLimit("k1", env)).rejects.toMatchObject({
      code: "RATE_LIMIT_UNAVAILABLE",
    });
  });

  it("allows when binding missing in dev", async () => {
    const env = {
      RATE_LIMIT_MODE: "on",
      ENVIRONMENT: "dev",
      RATE_LIMIT_DO: undefined as unknown as DurableObjectNamespace,
    } as Env;

    const out = await rateLimit("k1", env);
    expect(out.allowed).toBe(true);
  });
});

describe("assertAdminRequestIpAllowed", () => {
  it("allows when ADMIN_ALLOWED_IPS unset", () => {
    const req = new Request("http://localhost/", { headers: { "cf-connecting-ip": "1.2.3.4" } });
    assertAdminRequestIpAllowed(req, {} as Env);
  });

  it("rejects IP not in list", () => {
    const req = new Request("http://localhost/", { headers: { "cf-connecting-ip": "9.9.9.9" } });
    expect(() =>
      assertAdminRequestIpAllowed(req, { ADMIN_ALLOWED_IPS: "1.1.1.1,2.2.2.2" } as Env),
    ).toThrow();
  });

  it("allows matching IP for requireAdmin", async () => {
    const token = "x".repeat(32);
    await expect(
      requireAdmin(
        new Request("http://localhost/", {
          headers: {
            "cf-connecting-ip": "1.1.1.1",
            "x-admin-token": token,
          },
        }),
        { MASTER_ADMIN_TOKEN: token, ADMIN_ALLOWED_IPS: "1.1.1.1" } as Env,
      ),
    ).resolves.toEqual({ token });
  });

  it("requires signed admin headers in staging by default", async () => {
    const token = "y".repeat(32);
    const req = new Request("http://localhost/admin/webhooks/reprocess", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "1.1.1.1",
        "x-admin-token": token,
      },
    });
    await expect(
      requireAdmin(req, { MASTER_ADMIN_TOKEN: token, ADMIN_ALLOWED_IPS: "1.1.1.1", ENVIRONMENT: "staging" } as Env),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("accepts valid signed admin headers and rejects replay", async () => {
    const token = "z".repeat(32);
    const ts = Date.now().toString();
    const nonce = "nonce-1234567890";
    const method = "POST";
    const path = "/admin/webhooks/reprocess";
    const sig = createHmac("sha256", token).update(`${method}\n${path}\n${ts}\n${nonce}`).digest("hex");

    const req = new Request(`http://localhost${path}`, {
      method,
      headers: {
        "x-admin-timestamp": ts,
        "x-admin-nonce": nonce,
        "x-admin-signature": sig,
      },
    });

    await expect(
      requireAdmin(req, { MASTER_ADMIN_TOKEN: token, ENVIRONMENT: "production" } as Env),
    ).resolves.toEqual({ token: "<signed>" });

    const replayReq = new Request(`http://localhost${path}`, {
      method,
      headers: {
        "x-admin-timestamp": ts,
        "x-admin-nonce": nonce,
        "x-admin-signature": sig,
      },
    });
    await expect(
      requireAdmin(replayReq, { MASTER_ADMIN_TOKEN: token, ENVIRONMENT: "production" } as Env),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
