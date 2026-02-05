import { describe, expect, it } from "vitest";
import { getEnvironmentStage, validateStubModes, validateRateLimitConfig, type Env, getRateLimitMode } from "../src/env.js";

const baseEnv: Env = {
  SUPABASE_URL: "url",
  SUPABASE_SERVICE_ROLE_KEY: "key",
  OPENAI_API_KEY: "openai",
  API_KEY_SALT: "salt",
  MASTER_ADMIN_TOKEN: "admin",
  RATE_LIMIT_DO: {
    idFromName: () => ({} as DurableObjectId),
    get: () =>
      ({
        fetch: () => Promise.resolve(new Response(JSON.stringify({ allowed: true, count: 0, limit: 1, reset: 0 }))),
      }) as DurableObjectStub,
  },
};

describe("environment stub validation", () => {
  it("allows stub modes in non-prod", () => {
    const env: Env = { ...baseEnv, SUPABASE_MODE: "stub", EMBEDDINGS_MODE: "stub", ENVIRONMENT: "dev" };
    const stage = getEnvironmentStage(env);
    expect(stage).toBe("dev");
    expect(validateStubModes(env, stage)).toBeNull();
  });

  it("rejects stub modes in prod", () => {
    const env: Env = { ...baseEnv, SUPABASE_MODE: "stub", EMBEDDINGS_MODE: "stub", ENVIRONMENT: "prod" };
    const stage = getEnvironmentStage(env);
    const msg = validateStubModes(env, stage);
    expect(stage).toBe("prod");
    expect(msg).toContain("Stub modes are disallowed in production");
    expect(msg).toContain("SUPABASE_MODE=stub");
    expect(msg).toContain("EMBEDDINGS_MODE=stub");
  });
});

describe("rate limit config validation", () => {
  it("rejects missing RATE_LIMIT_DO when rate limit enabled in prod", () => {
    const env: Env = {
      ...baseEnv,
      ENVIRONMENT: "prod",
      RATE_LIMIT_DO: undefined as unknown as DurableObjectNamespace,
    };
    const err = validateRateLimitConfig(env, getEnvironmentStage(env));
    expect(err).toContain("RATE_LIMIT_DO binding is missing");
  });

  it("allows disabling rate limit only in dev", () => {
    const env: Env = { ...baseEnv, ENVIRONMENT: "dev", RATE_LIMIT_MODE: "off", RATE_LIMIT_DO: undefined as unknown as DurableObjectNamespace };
    const stage = getEnvironmentStage(env);
    expect(getRateLimitMode(env)).toBe("off");
    expect(validateRateLimitConfig(env, stage)).toBeNull();
  });
});
