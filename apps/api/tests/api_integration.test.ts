/**
 * Minimal integration tests for API endpoints: memories, search, episodes.
 * Uses stub Supabase and rate-limit DO; verifies status and response shape.
 * Recency decay: search results are ordered by score desc (stub applies score ordering).
 */

import { describe, expect, it } from "vitest";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import api from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateLimitDo = makeRateLimitDoStub();

const stubEnv = {
  SUPABASE_MODE: "stub",
  SUPABASE_URL: "stub",
  SUPABASE_SERVICE_ROLE_KEY: "stub",
  OPENAI_API_KEY: "sk-stub",
  API_KEY_SALT: "integration-salt",
  MASTER_ADMIN_TOKEN: "admin",
  EMBEDDINGS_MODE: "stub",
  RATE_LIMIT_DO: rateLimitDo as unknown as DurableObjectNamespace,
} satisfies Record<string, unknown>;

async function getStubApiKey(): Promise<{ apiKey: string; workspaceId: string }> {
  const wsRes = await api.fetch(
    new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ name: "int-ws" }),
    }),
    stubEnv as unknown as Record<string, unknown>,
  );
  expect(wsRes.status).toBe(200);
  const wsJson = await wsRes.json();
  const workspaceId = wsJson.workspace_id as string;

  const keyRes = await api.fetch(
    new Request("http://localhost/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ workspace_id: workspaceId, name: "int-key" }),
    }),
    stubEnv as unknown as Record<string, unknown>,
  );
  expect(keyRes.status).toBe(200);
  const keyJson = await keyRes.json();
  const apiKey = keyJson.api_key as string;
  return { apiKey, workspaceId };
}

describe("POST /v1/memories", () => {
  it("returns 200 and memory_id with valid auth", async () => {
    const { apiKey } = await getStubApiKey();
    const res = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ user_id: "u1", text: "Integration test memory", namespace: "default" }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.memory_id).toBe("string");
    expect(Number.isInteger(json.chunks)).toBe(true);
  });
});

describe("POST /v1/search", () => {
  it("returns 200 and results ordered by score descending", async () => {
    const { apiKey } = await getStubApiKey();
    await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ user_id: "u1", text: "Recency and ordering test", namespace: "default" }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );

    const res = await api.fetch(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ user_id: "u1", query: "ordering", top_k: 10 }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const results = json.results ?? [];
    expect(Array.isArray(results)).toBe(true);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });
});

describe("POST /v1/episodes", () => {
  it("returns 201 and id, created_at with valid auth", async () => {
    const { apiKey } = await getStubApiKey();
    const res = await api.fetch(
      new Request("http://localhost/v1/episodes", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          session_id: "sess-ep-1",
          event_type: "tool_call",
          tool_name: "test_tool",
          input_summary: "input",
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(typeof json.id).toBe("string");
    expect(typeof json.created_at).toBe("string");
  });
});

describe("GET /v1/episodes", () => {
  it("returns 200 and results including created episode", async () => {
    const { apiKey } = await getStubApiKey();
    const sessionId = "sess-list-" + Date.now();
    const createRes = await api.fetch(
      new Request("http://localhost/v1/episodes", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          session_id: sessionId,
          event_type: "agent_step",
          output_summary: "step done",
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(createRes.status).toBe(201);

    const listRes = await api.fetch(
      new Request(`http://localhost/v1/episodes?session_id=${encodeURIComponent(sessionId)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(listRes.status).toBe(200);
    const json = await listRes.json();
    expect(Array.isArray(json.results)).toBe(true);
    expect(json.results.length).toBeGreaterThanOrEqual(1);
    expect(json.results.some((r: { session_id?: string }) => r.session_id === sessionId)).toBe(true);
  });
});

describe("GET /v1/health", () => {
  it("returns 200 with status and version (no auth)", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/health", { method: "GET" }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(typeof json.version).toBe("string");
    expect(typeof json.embedding_model).toBe("string");
  });
});
