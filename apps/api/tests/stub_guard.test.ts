import type { DurableObjectId, DurableObjectStub } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { createSupabaseClient } from "../src/index.js";

type ApiEnv = Parameters<typeof createSupabaseClient>[0];

const baseEnv: ApiEnv = {
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OPENAI_API_KEY: "",
  API_KEY_SALT: "salt",
  MASTER_ADMIN_TOKEN: "adm",
  RATE_LIMIT_DO: {
    idFromName: () => ({} as DurableObjectId),
    get: () =>
      ({
        fetch: () => Promise.resolve(new Response(JSON.stringify({ allowed: true, count: 0, limit: 1, reset: 0 }))),
      }) as DurableObjectStub,
  },
};

describe("supabase stub guardrails", () => {
  it("throws when supabase vars missing and stub not enabled", () => {
    expect(() => createSupabaseClient(baseEnv)).toThrow(/Supabase env vars not set/);
  });

  it("allows stub only when SUPABASE_MODE=stub", () => {
    const env: ApiEnv = { ...baseEnv, SUPABASE_MODE: "stub" };
    expect(() => createSupabaseClient(env)).not.toThrow();
  });

  it("rejects stub in production", () => {
    const env: ApiEnv = { ...baseEnv, SUPABASE_MODE: "stub", ENVIRONMENT: "production" };
    expect(() => createSupabaseClient(env)).toThrow(/forbidden in production/);
  });
});
