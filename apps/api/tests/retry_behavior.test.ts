/**
 * Tests for launch-readiness retry behavior:
 * - OpenAI embeddings: retry on 5xx/429/network error
 * - Supabase Auth verify (dashboard session): retry on 5xx/429/network error
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import api from "../src/index.js";
import { verifySupabaseAccessToken } from "../src/dashboardSession.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateLimitDo = makeRateLimitDoStub();
const EMBED_DIM = 1536;

const envBase = {
  SUPABASE_MODE: "stub",
  SUPABASE_URL: "stub",
  SUPABASE_SERVICE_ROLE_KEY: "stub",
  OPENAI_API_KEY: "sk-test",
  API_KEY_SALT: "retry-test-salt",
  MASTER_ADMIN_TOKEN: "admin",
  RATE_LIMIT_DO: rateLimitDo as unknown as DurableObjectNamespace,
} satisfies Record<string, unknown>;

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", realFetch);
});

describe("embed retry (OpenAI)", () => {
  it("succeeds after one 500 then 200 (retry)", async () => {
    let embedCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (!url.includes("openai.com") || !url.includes("embeddings")) {
          return realFetch(input as RequestInfo);
        }
        embedCalls++;
        if (embedCalls === 1) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response(
          JSON.stringify({
            data: [{ embedding: Array(EMBED_DIM).fill(0.1) }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const env = { ...envBase, EMBEDDINGS_MODE: "openai" } as unknown as Record<string, unknown>;

    const wsRes = await api.fetch(
      new Request("http://localhost/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": "admin" },
        body: JSON.stringify({ name: "retry-ws" }),
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
        body: JSON.stringify({ workspace_id: workspaceId, name: "key" }),
      }),
      env,
    );
    expect(keyRes.status).toBe(200);
    const keyJson = await keyRes.json();
    const apiKey = keyJson.api_key as string;

    const ingestRes = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ user_id: "u1", text: "hello retry" }),
      }),
      env,
    );
    expect(ingestRes.status).toBe(200);
    expect(embedCalls).toBe(2);
  });

  it("fails after exhausting retries (500 three times)", async () => {
    let embedCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (!url.includes("openai.com") || !url.includes("embeddings")) {
          return realFetch(input as RequestInfo);
        }
        embedCalls++;
        return new Response("Internal Server Error", { status: 500 });
      }),
    );

    const env = { ...envBase, EMBEDDINGS_MODE: "openai" } as unknown as Record<string, unknown>;

    const wsRes = await api.fetch(
      new Request("http://localhost/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": "admin" },
        body: JSON.stringify({ name: "fail-ws" }),
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
        body: JSON.stringify({ workspace_id: workspaceId, name: "key" }),
      }),
      env,
    );
    expect(keyRes.status).toBe(200);
    const keyJson = await keyRes.json();
    const apiKey = keyJson.api_key as string;

    const ingestRes = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ user_id: "u1", text: "hello" }),
      }),
      env,
    );
    expect(ingestRes.status).toBe(500);
    expect(embedCalls).toBe(3);
  });
});

describe("verifySupabaseAccessToken retry", () => {
  it("returns userId after one 500 then 200", async () => {
    let authCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (!url.includes("/auth/v1/user")) {
          return realFetch(input as RequestInfo);
        }
        authCalls++;
        if (authCalls === 1) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return new Response(JSON.stringify({ id: "user-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const env = {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "anon",
    } as Parameters<typeof verifySupabaseAccessToken>[1];

    const result = await verifySupabaseAccessToken("token", env);
    expect(result).toEqual({ userId: "user-123" });
    expect(authCalls).toBe(2);
  });

  it("returns null after exhausting retries (503 three times)", async () => {
    let authCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (!url.includes("/auth/v1/user")) {
          return realFetch(input as RequestInfo);
        }
        authCalls++;
        return new Response("Service Unavailable", { status: 503 });
      }),
    );

    const env = {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "anon",
    } as Parameters<typeof verifySupabaseAccessToken>[1];

    const result = await verifySupabaseAccessToken("token", env);
    expect(result).toBeNull();
    expect(authCalls).toBe(3);
  });

  it("returns null immediately on 401 (no retry)", async () => {
    let authCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (!url.includes("/auth/v1/user")) {
          return realFetch(input as RequestInfo);
        }
        authCalls++;
        return new Response("Unauthorized", { status: 401 });
      }),
    );

    const env = {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "anon",
    } as Parameters<typeof verifySupabaseAccessToken>[1];

    const result = await verifySupabaseAccessToken("token", env);
    expect(result).toBeNull();
    expect(authCalls).toBe(1);
  });
});
