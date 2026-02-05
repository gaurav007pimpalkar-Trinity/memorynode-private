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
    expect(json.status).toBe("ok");
    expect(json.version).toBe("dev");
    expect(json.stage).toBeUndefined();
  });

  it("returns supplied BUILD_VERSION and stage", async () => {
    const env = { ...baseEnv, BUILD_VERSION: "test-version", ENVIRONMENT: "staging" };
    const res = await api.fetch(new Request("http://localhost/healthz"), env as unknown as FetchEnv);
    const json = await res.json();
    expect(json.version).toBe("test-version");
    expect(json.stage).toBe("staging");
  });
});
