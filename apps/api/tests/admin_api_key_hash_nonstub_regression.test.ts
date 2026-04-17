import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

type WorkspaceRow = {
  id: string;
  name: string;
  plan: "free" | "pro" | "team";
  plan_status: "free" | "trialing" | "active" | "past_due" | "canceled";
};

type ApiKeyRow = {
  id: string;
  workspace_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  key_last4: string;
  created_at: string;
  revoked_at: string | null;
};

type MockState = {
  insertedKeyHash: string | null;
  lookupHash: string | null;
  apiKeyRows: Map<string, ApiKeyRow>;
};

type SupabaseLike = {
  from: (table: string) => Record<string, unknown>;
  rpc: (name: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  __state: MockState;
};

let currentSupabase: SupabaseLike | null = null;

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => {
    if (!currentSupabase) {
      throw new Error("test supabase client not initialized");
    }
    return currentSupabase;
  }),
}));

const rateLimitDo = makeRateLimitDoStub();

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function makeSupabaseMock(apiKeySalt: string): SupabaseLike {
  const workspaces = new Map<string, WorkspaceRow>();
  const entitlements = new Map<string, Record<string, unknown>>();
  const state: MockState = {
    insertedKeyHash: null,
    lookupHash: null,
    apiKeyRows: new Map<string, ApiKeyRow>(),
  };

  return {
    __state: state,
    from(table: string) {
      if (table === "app_settings") {
        return {
          select: () => ({
            limit: () => ({
              single: async () => ({ data: { api_key_salt: apiKeySalt }, error: null }),
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
          insert: () => ({ error: null }),
        };
      }

      if (table === "workspaces") {
        return {
          insert: (payload: { name: string }) => ({
            select: () => ({
              single: async () => {
                const id = `ws-${workspaces.size + 1}`;
                const row: WorkspaceRow = {
                  id,
                  name: payload.name,
                  plan: "free",
                  plan_status: "active",
                };
                workspaces.set(id, row);
                entitlements.set(id, {
                  id: `ent-${id}`,
                  workspace_id: id,
                  source_txn_id: `txn-${id}`,
                  plan_code: "launch",
                  status: "active",
                  starts_at: new Date(Date.now() - 60_000).toISOString(),
                  expires_at: null,
                  caps_json: { writes: 250, reads: 1000, embeds: 500 },
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                });
                return { data: { id: row.id, name: row.name }, error: null };
              },
            }),
          }),
          select: () => ({
            eq: (_col: string, workspaceId: string) => ({
              maybeSingle: async () => {
                const row = workspaces.get(workspaceId);
                if (!row) return { data: null, error: null };
                return { data: { plan: row.plan, plan_status: row.plan_status }, error: null };
              },
            }),
          }),
        };
      }

      if (table === "workspace_entitlements") {
        return {
          select: () => ({
            eq: (_col: string, workspaceId: string) => ({
              order: () => ({
                limit: async () => ({
                  data: entitlements.has(workspaceId) ? [entitlements.get(workspaceId)] : [],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === "api_keys") {
        return {
          insert: (payload: {
            workspace_id: string;
            name: string;
            key_hash: string;
            key_prefix: string;
            key_last4: string;
          }) => ({
            select: () => ({
              single: async () => {
                const row: ApiKeyRow = {
                  id: `key-${state.apiKeyRows.size + 1}`,
                  workspace_id: payload.workspace_id,
                  name: payload.name,
                  key_hash: payload.key_hash,
                  key_prefix: payload.key_prefix,
                  key_last4: payload.key_last4,
                  created_at: new Date().toISOString(),
                  revoked_at: null,
                };
                state.apiKeyRows.set(row.key_hash, row);
                state.insertedKeyHash = row.key_hash;
                return {
                  data: {
                    id: row.id,
                    workspace_id: row.workspace_id,
                    name: row.name,
                    key_prefix: row.key_prefix,
                    key_last4: row.key_last4,
                    created_at: row.created_at,
                    revoked_at: row.revoked_at,
                  },
                  error: null,
                };
              },
            }),
          }),
          select: () => {
            let hashFilter: string | null = null;
            let revokedNullFilter = false;
            const builder = {
              eq(col: string, val: unknown) {
                if (col === "key_hash") hashFilter = String(val);
                return builder;
              },
              is(col: string, val: unknown) {
                if (col === "revoked_at" && val === null) revokedNullFilter = true;
                return builder;
              },
              single: async () => {
                state.lookupHash = hashFilter;
                const row = hashFilter ? state.apiKeyRows.get(hashFilter) : null;
                if (!row || (revokedNullFilter && row.revoked_at !== null)) {
                  return { data: null, error: { code: "PGRST116", message: "No rows" } };
                }
                const ws = workspaces.get(row.workspace_id);
                return {
                  data: {
                    id: row.id,
                    workspace_id: row.workspace_id,
                    workspaces: {
                      plan: ws?.plan ?? "free",
                      plan_status: ws?.plan_status ?? "free",
                    },
                  },
                  error: null,
                };
              },
            };
            return builder;
          },
        };
      }

      if (table === "usage_daily") {
        return {
          select: () => ({
            eq: (colA: string, valA: unknown) => ({
              eq: (colB: string, valB: unknown) => ({
                maybeSingle: async () => {
                  const workspaceId =
                    colA === "workspace_id"
                      ? String(valA)
                      : colB === "workspace_id"
                        ? String(valB)
                        : "";
                  const hasWorkspace = workspaces.has(workspaceId);
                  return {
                    data: hasWorkspace ? { writes: 0, reads: 0, embeds: 0 } : null,
                    error: null,
                  };
                },
              }),
            }),
          }),
        };
      }

      if (table === "api_audit_log") {
        return {
          insert: () => ({ error: null }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
    async rpc() {
      return { data: null, error: null };
    },
  };
}

describe("admin API key hash regression (non-stub Supabase path)", () => {
  it("creates key via admin route and authenticates usage endpoint with same hash", async () => {
    vi.resetModules();
    currentSupabase = makeSupabaseMock("nonstub-salt");
    const { default: api } = await import("../src/index.js");

    const env = {
      SUPABASE_URL: "https://supabase.local",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      OPENAI_API_KEY: "sk-stub",
      API_KEY_SALT: "",
      MASTER_ADMIN_TOKEN: "admin",
      EMBEDDINGS_MODE: "stub",
      RATE_LIMIT_DO: rateLimitDo as unknown as DurableObjectNamespace,
    } satisfies Record<string, unknown>;

    const wsRes = await api.fetch(
      new Request("http://localhost/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": "admin" },
        body: JSON.stringify({ name: "nonstub-hash-regression" }),
      }),
      env,
    );
    expect(wsRes.status).toBe(200);
    const wsJson = await wsRes.json();
    const workspaceId = wsJson.workspace_id as string;

    const keyRes = await api.fetch(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": "admin" },
        body: JSON.stringify({ workspace_id: workspaceId, name: "nonstub-key" }),
      }),
      env,
    );
    expect(keyRes.status).toBe(200);
    const keyJson = await keyRes.json();
    const apiKey = keyJson.api_key as string;
    expect(apiKey).toMatch(/^mn_live_/);

    const expectedHash = sha256Hex(`nonstub-salt${apiKey}`);
    expect(currentSupabase.__state.insertedKeyHash).toBe(expectedHash);

    const usageRes = await api.fetch(
      new Request("http://localhost/v1/usage/today", {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      env,
    );
    expect(usageRes.status).toBe(200);
    expect(currentSupabase.__state.lookupHash).toBe(expectedHash);
  });
});
