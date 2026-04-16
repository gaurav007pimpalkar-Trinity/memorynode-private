import { describe, expect, it } from "vitest";
import api from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateDo = makeRateLimitDoStub();
const baseEnv = {
  RATE_LIMIT_DO: rateDo,
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OPENAI_API_KEY: "",
  API_KEY_SALT: "s",
  MASTER_ADMIN_TOKEN: "",
  ALLOWED_ORIGINS: "https://allowed.com",
} as const;

type FetchEnv = Parameters<(typeof api)["fetch"]>[1];

describe("CORS strict allowlist", () => {
  it("requests without origin are allowed for non-browser clients", async () => {
    const res = await api.fetch(
      new Request("http://localhost/healthz"),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allowed origin gets CORS headers", async () => {
    const res = await api.fetch(
      new Request("http://localhost/healthz", { headers: { origin: "https://allowed.com" } }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("disallowed origin gets no CORS headers", async () => {
    const res = await api.fetch(
      new Request("http://localhost/healthz", { headers: { origin: "https://blocked.com" } }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("preflight allowed includes security headers", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "OPTIONS",
        headers: {
          origin: "https://allowed.com",
          "access-control-request-headers": "authorization,content-type",
        },
      }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://allowed.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("preflight disallowed does not leak headers", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "OPTIONS",
        headers: {
          origin: "https://blocked.com",
        },
      }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
