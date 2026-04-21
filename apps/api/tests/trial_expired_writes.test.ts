/**
 * Regression: expired workspace trial blocks mutating REST routes with 402 TRIAL_EXPIRED (reads unchanged elsewhere).
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleCreateMemory } from "../src/index.js";
import { makeSimpleSupabase } from "./helpers/supabase.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateLimitDo = makeRateLimitDoStub(100, 60_000);

function makeEnv(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    OPENAI_API_KEY: "",
    API_KEY_SALT: "salt",
    MASTER_ADMIN_TOKEN: "",
    RATE_LIMIT_DO: rateLimitDo,
    EMBEDDINGS_MODE: "stub",
    ...overrides,
  };
}

describe("trial expired write blocking", () => {
  it("returns 402 TRIAL_EXPIRED with upgrade_url when POST /v1/memories and trial ended", async () => {
    const supabase = makeSimpleSupabase({
      plan_status: "trialing",
      workspace: {
        trial: true,
        trial_expires_at: "2000-01-01T00:00:00.000Z",
        plan_status: "trialing",
      },
    }) as unknown as SupabaseClient;

    const res = await handleCreateMemory(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", text: "hello", extract: false }),
      }),
      makeEnv({ PUBLIC_APP_URL: "https://app.memorynode.test" }) as Record<string, unknown>,
      supabase,
      {},
    );

    expect(res.status).toBe(402);
    const json = (await res.json()) as {
      error?: { code?: string; message?: string; upgrade_required?: boolean };
      upgrade_url?: string;
    };
    expect(json.error?.code).toBe("TRIAL_EXPIRED");
    expect(json.error?.upgrade_required).toBe(true);
    expect(typeof json.error?.message).toBe("string");
    expect(json.upgrade_url).toBe("https://app.memorynode.test/billing");
  });

  it("omits upgrade_url when PUBLIC_APP_URL is unset", async () => {
    const supabase = makeSimpleSupabase({
      plan_status: "trialing",
      workspace: {
        trial: true,
        trial_expires_at: "1999-06-01T00:00:00.000Z",
        plan_status: "trialing",
      },
    }) as unknown as SupabaseClient;

    const res = await handleCreateMemory(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", text: "hello", extract: false }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase,
      {},
    );

    expect(res.status).toBe(402);
    const json = (await res.json()) as { error?: { code?: string }; upgrade_url?: string };
    expect(json.error?.code).toBe("TRIAL_EXPIRED");
    expect(json.upgrade_url).toBeUndefined();
  });
});
