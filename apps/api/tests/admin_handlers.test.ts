/**
 * Admin endpoints: require admin token, session cleanup, billing health, webhook reprocess validation.
 */

import { describe, expect, it } from "vitest";
import api from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateDo = makeRateLimitDoStub();
type FetchEnv = Parameters<(typeof api)["fetch"]>[1];

const baseEnv: Record<string, unknown> = {
  RATE_LIMIT_DO: rateDo,
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OPENAI_API_KEY: "",
  API_KEY_SALT: "s",
  MASTER_ADMIN_TOKEN: "admin-token-123",
  ENVIRONMENT: "dev",
};

describe("Admin: require admin token", () => {
  it("GET /v1/admin/billing/health returns 401 without x-admin-token", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await api.fetch(
      new Request("http://localhost/v1/admin/billing/health"),
      env as FetchEnv,
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error?.code).toBe("UNAUTHORIZED");
  });

  it("GET /v1/admin/billing/health returns 200 with valid x-admin-token (stub)", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await api.fetch(
      new Request("http://localhost/v1/admin/billing/health", {
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("now");
    expect(json).toHaveProperty("db_connectivity");
    expect(json.db_connectivity).toHaveProperty("ok", true);
  });

  it("POST /admin/sessions/cleanup returns 401 without x-admin-token", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await api.fetch(
      new Request("http://localhost/admin/sessions/cleanup", { method: "POST" }),
      env as FetchEnv,
    );
    expect(res.status).toBe(401);
  });

  it("POST /admin/sessions/cleanup returns 200 with valid x-admin-token (stub)", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await api.fetch(
      new Request("http://localhost/admin/sessions/cleanup", {
        method: "POST",
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.deleted).toBe("number");
  });

  it("POST /admin/usage/reconcile returns 200 with valid x-admin-token (stub)", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await api.fetch(
      new Request("http://localhost/admin/usage/reconcile?limit=5", {
        method: "POST",
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.scanned).toBe("number");
    expect(Array.isArray(json.results)).toBe(true);
  });

  it("POST /admin/webhooks/reprocess returns 400 when status is invalid", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await api.fetch(
      new Request("http://localhost/admin/webhooks/reprocess?status=invalid", {
        method: "POST",
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error?.code).toBe("BAD_REQUEST");
    expect(String(json.error?.message)).toMatch(/status must be one of/);
  });
});
