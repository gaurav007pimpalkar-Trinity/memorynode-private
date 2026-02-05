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
} as const;

type FetchEnv = Parameters<(typeof api)["fetch"]>[1];

describe("security headers", () => {
  it("healthz returns baseline security headers", async () => {
    const res = await api.fetch(new Request("http://localhost/healthz"), baseEnv as unknown as FetchEnv);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toBe("geolocation=(), microphone=(), camera=()");
    expect(res.headers.get("cache-control")).toBe("private, no-cache, must-revalidate");
  });

  it("error responses still carry security headers", async () => {
    const big = "x".repeat(250_001);
    const res = await api.fetch(
      new Request("http://localhost/v1/search", { method: "POST", body: big }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-cache, must-revalidate");
  });

  it("sensitive endpoints set no-store cache headers", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/api-keys", { method: "OPTIONS" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
