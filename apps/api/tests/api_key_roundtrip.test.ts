import { describe, expect, it } from "vitest";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import api from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateLimitDo = makeRateLimitDoStub();

const envBase = {
  SUPABASE_MODE: "stub",
  SUPABASE_URL: "stub",
  SUPABASE_SERVICE_ROLE_KEY: "stub",
  OPENAI_API_KEY: "sk-stub",
  API_KEY_SALT: "roundtrip-salt",
  MASTER_ADMIN_TOKEN: "admin",
  EMBEDDINGS_MODE: "stub",
  RATE_LIMIT_DO: rateLimitDo as unknown as DurableObjectNamespace,
} satisfies Record<string, unknown>;

describe("api key roundtrip", () => {
  it("creates a workspace + api key and authenticates ingest/search", async () => {
    // create workspace
    const wsRes = await api.fetch(new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ name: "rt" }),
    }), envBase as unknown as Record<string, unknown>);
    expect(wsRes.status).toBe(200);
    const wsJson = await wsRes.json();
    const workspaceId = wsJson.workspace_id as string;

    // create api key
    const keyRes = await api.fetch(new Request("http://localhost/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ workspace_id: workspaceId, name: "key" }),
    }), envBase as unknown as Record<string, unknown>);
    expect(keyRes.status).toBe(200);
    const keyJson = await keyRes.json();
    const apiKey = keyJson.api_key as string;
    expect(apiKey).toMatch(/^mn_live_/);

    // ingest
    const ingestRes = await api.fetch(new Request("http://localhost/v1/memories", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ user_id: "u1", text: "hello world" }),
    }), envBase as unknown as Record<string, unknown>);
    expect(ingestRes.status).toBe(200);

    // search
    const searchRes = await api.fetch(new Request("http://localhost/v1/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ user_id: "u1", query: "hello", top_k: 3 }),
    }), envBase as unknown as Record<string, unknown>);
    expect(searchRes.status).toBe(200);
    const searchJson = await searchRes.json();
    expect((searchJson.results ?? []).length).toBeGreaterThan(0);
  });
});
