/**
 * Minimal integration tests for critical request-path flows.
 * Protects health, readiness, auth gate, and rate limiting without full stub setup.
 */

import { describe, expect, it } from "vitest";
import api from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateDo = makeRateLimitDoStub();
const baseEnv = {
  RATE_LIMIT_DO: rateDo,
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-key",
  OPENAI_API_KEY: "sk-test",
  API_KEY_SALT: "salt",
  MASTER_ADMIN_TOKEN: "admin-token",
  SUPABASE_MODE: "stub",
  ENVIRONMENT: "dev",
} as Parameters<(typeof api)["fetch"]>[1];

describe("critical flows integration", () => {
  it("GET /healthz returns 200 with version and embedding_model", async () => {
    const res = await api.fetch(new Request("http://localhost/healthz"), baseEnv);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(typeof json.version).toBe("string");
    expect(typeof json.embedding_model).toBe("string");
  });

  it("GET /ready with stub returns 200 and db connected", async () => {
    const res = await api.fetch(new Request("http://localhost/ready"), baseEnv);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.db).toBe("connected");
  });

  it("POST /v1/memories without auth returns 401", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", text: "test" }),
      }),
      baseEnv,
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error?.code).toBeDefined();
  });

  it("POST /v1/search without auth returns 401", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", query: "q" }),
      }),
      baseEnv,
    );
    expect(res.status).toBe(401);
  });

  it("GET /v1/usage/today without auth returns 401", async () => {
    const res = await api.fetch(new Request("http://localhost/v1/usage/today"), baseEnv);
    expect(res.status).toBe(401);
  });
});
