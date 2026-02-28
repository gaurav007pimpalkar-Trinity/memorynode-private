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

describe("/healthz version stamp", () => {
  it("returns default dev version when BUILD_VERSION is unset", async () => {
    const res = await api.fetch(new Request("http://localhost/healthz"), baseEnv as unknown as FetchEnv);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toEqual(expect.any(String));
    expect(json.status).toBe("ok");
    expect(json.version).toBe("dev");
    expect(json.stage).toBeUndefined();
  });

  it("returns supplied BUILD_VERSION and stage", async () => {
    const env = { ...baseEnv, BUILD_VERSION: "test-version", ENVIRONMENT: "staging", GIT_SHA: "abc1234" };
    const res = await api.fetch(new Request("http://localhost/healthz"), env as unknown as FetchEnv);
    const json = await res.json();
    expect(json.version).toBe("test-version");
    expect(json.build_version).toBe("test-version");
    expect(json.git_sha).toBe("abc1234");
    expect(json.stage).toBe("staging");
  });
});

describe("GET /ready (deep readiness)", () => {
  it("returns 200 and db connected when DB is reachable (stub)", async () => {
    const env = {
      ...baseEnv,
      SUPABASE_MODE: "stub",
      ENVIRONMENT: "dev",
    } as unknown as FetchEnv;
    const res = await api.fetch(new Request("http://localhost/ready"), env);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe("ok");
    expect(json.db).toBe("connected");
  });

  it("accepts /ready/ with trailing slash", async () => {
    const env = {
      ...baseEnv,
      SUPABASE_MODE: "stub",
      ENVIRONMENT: "dev",
    } as unknown as FetchEnv;
    const res = await api.fetch(new Request("http://localhost/ready/"), env);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe("ok");
    expect(json.db).toBe("connected");
  });
});
