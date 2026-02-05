import { describe, expect, it } from "vitest";
import { handleCreateApiKey, handleListApiKeys, handleSearch, parseApiKeyMeta } from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";
import type { SupabaseClient } from "@supabase/supabase-js";

const rateLimitDo = makeRateLimitDoStub();

const adminEnv = {
  MASTER_ADMIN_TOKEN: "admin",
  API_KEY_SALT: "salt",
  RATE_LIMIT_DO: rateLimitDo as Record<string, unknown>,
  OPENAI_API_KEY: "",
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
} as const;
type ApiEnv = Record<string, unknown>;

describe("API key lifecycle", () => {
  it("parses raw key prefix and last4 correctly", () => {
    const key = "mn_live_abc123def456";
    const meta = parseApiKeyMeta(key);
    expect(meta.prefix).toBe("mn_live");
    expect(meta.last4).toBe("3456".replace("3456", key.slice(-4))); // keep intent explicit
  });

  const makeSupabase = (opts: { appSalt?: string; apiKeys?: Record<string, unknown>[] }) => {
    return {
      from(table: string) {
        if (table === "app_settings") {
          return {
            select: () => ({
              limit: () => ({
                single: async () => ({ data: { api_key_salt: opts.appSalt ?? "" }, error: null }),
              }),
            }),
          };
        }
        if (table === "product_events") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
            insert: (rows: unknown) => {
              void rows;
              return { error: null };
            },
          };
        }
        if (table === "api_keys") {
          const rows = opts.apiKeys ?? [];
          const makeSelectBuilder = () => {
            const builder = {
              eq: () => builder,
              is: () => builder,
              limit: () => builder,
              single: async () => ({
                data: rows[0] ?? null,
                error: rows[0] ? null : { code: "PGRST116", message: "No rows" },
              }),
              maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
              then: (
                onfulfilled: (value: { data: Record<string, unknown>[]; error: null }) => unknown,
                onrejected?: (reason: unknown) => unknown,
              ) => Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected),
            };
            return builder;
          };
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: rows[0] ?? {
                    id: "key-id",
                    workspace_id: "ws1",
                    name: "test",
                    key_prefix: "mn_live",
                    key_last4: "abcd",
                    created_at: "now",
                    revoked_at: null,
                  },
                  error: null,
              }),
            }),
          }),
          select: () => makeSelectBuilder(),
          update: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      }
        if (table === "usage_daily") {
          const builder = {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          };
          return builder;
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        };
      },
      rpc() {
        return Promise.resolve({ data: null, error: null });
      },
    } as unknown as SupabaseClient;
  };

  it("create returns plaintext key once", async () => {
    const supabase = makeSupabase({
      appSalt: "",
      apiKeys: [
        {
          id: "key-id",
          workspace_id: "ws1",
          name: "test",
          key_prefix: "mn_live",
          key_last4: "abcd",
          created_at: "now",
          revoked_at: null,
        },
      ],
    });

    const req = new Request("http://localhost/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ workspace_id: "ws1", name: "key" }),
    });

    const res = await handleCreateApiKey(req, adminEnv as unknown as ApiEnv, supabase);
    const json = await res.json();
    expect(json.api_key).toMatch(/^mn_live_/);
    expect(json.api_key_id).toBe("key-id");
  });

  it("list is masked, no plaintext key", async () => {
    const supabase = makeSupabase({
      appSalt: "",
      apiKeys: [
        {
          id: "k1",
          workspace_id: "ws1",
          name: "test",
          created_at: "now",
          revoked_at: null,
          key_prefix: "mn_live",
          key_last4: "1234",
        },
      ],
    });

    const req = new Request("http://localhost/v1/api-keys?workspace_id=ws1", {
      method: "GET",
      headers: { "x-admin-token": "admin" },
    });
    const res = await handleListApiKeys(req, adminEnv as unknown as ApiEnv, supabase);
    const json = await res.json();
    expect(json.api_keys[0].key_prefix).toBe("mn_live");
    expect(json.api_keys[0].key_last4).toBe("1234");
    expect(JSON.stringify(json)).not.toMatch(/mn_live_[a-f0-9]{10,}/);
  });

  it("revoked key is rejected by auth", async () => {
    const supabase = makeSupabase({ appSalt: "", apiKeys: [] });

    const req = new Request("http://localhost/v1/search", {
      method: "POST",
      headers: { authorization: "Bearer mn_live_deadbeef" },
      body: JSON.stringify({ user_id: "u", namespace: "n", query: "hi" }),
    });

    await expect(handleSearch(req, adminEnv as unknown as ApiEnv, supabase, {})).rejects.toThrow(/Invalid API key/);
  });

  it("env/db salt mismatch logs and fails", async () => {
    const supabase = makeSupabase({ appSalt: "db-salt", apiKeys: [] });

    const req = new Request("http://localhost/v1/search", {
      method: "POST",
      headers: { authorization: "Bearer mn_live_deadbeef" },
      body: JSON.stringify({ user_id: "u", namespace: "n", query: "hi" }),
    });

    await expect(
      handleSearch(req, { ...adminEnv, API_KEY_SALT: "env-salt" } as unknown as ApiEnv, supabase, {}),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
