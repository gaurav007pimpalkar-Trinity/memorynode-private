import api from "../src/index.js";
import { describe, expect, it } from "vitest";

/** Public Worker guard requires these for non-dev stages before other config checks run. */
const controlPlaneEnvPair = {
  CONTROL_PLANE_ORIGIN: "https://control-plane.test",
  CONTROL_PLANE_SECRET: "control-plane-test-secret-32chars!!",
} as const;

describe("config guard", () => {
  function rateLimitBinding() {
    return {
      idFromName: () => "id",
      get: () => ({ fetch: async () => new Response("{}") }),
    };
  }

  it("fails fast when RATE_LIMIT_DO binding is missing", async () => {
    const req = new Request("http://localhost/healthz", { method: "GET" });
    const env = {
      ...controlPlaneEnvPair,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service_role",
      OPENAI_API_KEY: "sk-test",
      API_KEY_SALT: "salt",
      MASTER_ADMIN_TOKEN: "admin",
      ENVIRONMENT: "production",
      // RATE_LIMIT_DO intentionally omitted
    } as unknown as Record<string, unknown>;

    const res = await api.fetch(req, env);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe("CONFIG_ERROR");
    expect(String(json.message ?? json.error?.message)).toContain("RATE_LIMIT");
  });

  it("rejects RATE_LIMIT_MODE=off in production", async () => {
    const req = new Request("http://localhost/healthz", { method: "GET" });
    const env = {
      ...controlPlaneEnvPair,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service_role",
      OPENAI_API_KEY: "sk-test",
      API_KEY_SALT: "salt",
      MASTER_ADMIN_TOKEN: "admin",
      RATE_LIMIT_DO: rateLimitBinding(),
      ENVIRONMENT: "production",
      RATE_LIMIT_MODE: "off",
    } as unknown as Record<string, unknown>;

    const res = await api.fetch(req, env);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("CONFIG_ERROR");
    expect(String(json.error.message)).toContain("RATE_LIMIT_MODE=off");
  });

  it("rejects SUPABASE_MODE=stub in production", async () => {
    const req = new Request("http://localhost/healthz", { method: "GET" });
    const env = {
      ...controlPlaneEnvPair,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service_role",
      OPENAI_API_KEY: "sk-test",
      API_KEY_SALT: "salt",
      MASTER_ADMIN_TOKEN: "admin",
      RATE_LIMIT_DO: rateLimitBinding(),
      ENVIRONMENT: "production",
      SUPABASE_MODE: "stub",
    } as unknown as Record<string, unknown>;

    const res = await api.fetch(req, env);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("CONFIG_ERROR");
    expect(String(json.error.message)).toContain("SUPABASE_MODE=stub");
  });

  it("returns 503 when dashboard route is used in staging without ALLOWED_ORIGINS", async () => {
    const req = new Request("http://localhost/v1/dashboard/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "token", workspace_id: "ws1" }),
    });
    const env = {
      ...controlPlaneEnvPair,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service_role",
      OPENAI_API_KEY: "sk-test",
      API_KEY_SALT: "salt",
      MASTER_ADMIN_TOKEN: "admin",
      RATE_LIMIT_DO: rateLimitBinding(),
      ENVIRONMENT: "staging",
      // ALLOWED_ORIGINS intentionally unset
    } as unknown as Record<string, unknown>;

    const res = await api.fetch(req, env);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error?.code).toBe("CONFIG_ERROR");
    expect(String(json.error?.message)).toContain("ALLOWED_ORIGINS");
  });

  it("rejects EMBEDDINGS_MODE=stub in prod alias stage", async () => {
    const req = new Request("http://localhost/healthz", { method: "GET" });
    const env = {
      ...controlPlaneEnvPair,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service_role",
      OPENAI_API_KEY: "sk-test",
      API_KEY_SALT: "salt",
      MASTER_ADMIN_TOKEN: "admin",
      RATE_LIMIT_DO: rateLimitBinding(),
      ENVIRONMENT: "prod",
      EMBEDDINGS_MODE: "stub",
    } as unknown as Record<string, unknown>;

    const res = await api.fetch(req, env);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("CONFIG_ERROR");
    expect(String(json.error.message)).toContain("EMBEDDINGS_MODE=stub");
  });
});
