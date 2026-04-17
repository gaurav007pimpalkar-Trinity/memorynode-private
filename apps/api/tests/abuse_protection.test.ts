import { describe, expect, it } from "vitest";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import api from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

type FetchEnv = Parameters<(typeof api)["fetch"]>[1];

function makeEnv(rateLimitMax = 1): Record<string, unknown> {
  return {
    SUPABASE_MODE: "stub",
    SUPABASE_URL: "stub",
    SUPABASE_SERVICE_ROLE_KEY: "stub",
    OPENAI_API_KEY: "sk-stub",
    API_KEY_SALT: "abuse-test-salt",
    MASTER_ADMIN_TOKEN: "admin",
    EMBEDDINGS_MODE: "stub",
    RATE_LIMIT_DO: makeRateLimitDoStub(rateLimitMax) as unknown as DurableObjectNamespace,
  };
}

async function bootstrapApiKey(env: FetchEnv): Promise<string> {
  const bootstrapEnv = {
    ...(env as unknown as Record<string, unknown>),
    RATE_LIMIT_MODE: "off",
  } as unknown as FetchEnv;

  const workspaceRes = await api.fetch(
    new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ name: `abuse-${Date.now()}` }),
    }),
    bootstrapEnv,
  );
  expect(workspaceRes.status).toBe(200);
  const workspaceJson = (await workspaceRes.json()) as { workspace_id: string };

  const keyRes = await api.fetch(
    new Request("http://localhost/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ workspace_id: workspaceJson.workspace_id, name: "abuse-key" }),
    }),
    bootstrapEnv,
  );
  expect(keyRes.status).toBe(200);
  const keyJson = (await keyRes.json()) as { api_key: string };
  return keyJson.api_key;
}

async function bootstrapWorkspace(env: FetchEnv): Promise<string> {
  const bootstrapEnv = {
    ...(env as unknown as Record<string, unknown>),
    RATE_LIMIT_MODE: "off",
  } as unknown as FetchEnv;
  const workspaceRes = await api.fetch(
    new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ name: `abuse-shared-${Date.now()}` }),
    }),
    bootstrapEnv,
  );
  expect(workspaceRes.status).toBe(200);
  const workspaceJson = (await workspaceRes.json()) as { workspace_id: string };
  return workspaceJson.workspace_id;
}

async function bootstrapApiKeyForWorkspace(env: FetchEnv, workspaceId: string, name: string): Promise<string> {
  const bootstrapEnv = {
    ...(env as unknown as Record<string, unknown>),
    RATE_LIMIT_MODE: "off",
  } as unknown as FetchEnv;
  const keyRes = await api.fetch(
    new Request("http://localhost/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ workspace_id: workspaceId, name }),
    }),
    bootstrapEnv,
  );
  expect(keyRes.status).toBe(200);
  const keyJson = (await keyRes.json()) as { api_key: string };
  return keyJson.api_key;
}

async function occupyWorkspaceConcurrencySlot(env: FetchEnv, workspaceId: string): Promise<void> {
  const ns = (env as unknown as { RATE_LIMIT_DO: DurableObjectNamespace }).RATE_LIMIT_DO;
  const id = ns.idFromName(`conc-ws:${workspaceId}`);
  const stub = ns.get(id);
  const res = await stub.fetch("https://rate-limit/concurrency", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "concurrency_acquire",
      limit: 1,
      ttl_ms: 30_000,
      token: `occupied-${workspaceId}`,
    }),
  });
  expect(res.status).toBe(200);
}

async function expectRateLimitedResponse(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toEqual(expect.any(String));
  expect(response.headers.get("x-request-id")).toEqual(expect.any(String));
  const payload = (await response.json()) as { request_id?: string; error?: { code?: string } };
  expect(payload.error?.code).toBe("rate_limited");
  expect(payload.request_id).toBe(response.headers.get("x-request-id"));
}

describe("abuse protection", () => {
  it("rate-limits both /v1/search and /v1/memories with request_id + retry-after", async () => {
    const env = makeEnv(1) as unknown as FetchEnv;
    const apiKey = await bootstrapApiKey(env);

    const searchFirst = await api.fetch(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", query: "hello", top_k: 3 }),
      }),
      env,
    );
    expect(searchFirst.status).toBe(200);

    const searchSecond = await api.fetch(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", query: "hello", top_k: 3 }),
      }),
      env,
    );
    await expectRateLimitedResponse(searchSecond);

    const envMemories = makeEnv(1) as unknown as FetchEnv;
    const memoriesKey = await bootstrapApiKey(envMemories);
    const ingestFirst = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { authorization: `Bearer ${memoriesKey}`, "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", text: "hello memory" }),
      }),
      envMemories,
    );
    expect(ingestFirst.status).toBe(200);

    // Switching header style (Bearer -> x-api-key) must not bypass the limiter.
    const ingestSecond = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { "x-api-key": memoriesKey, "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", text: "hello memory 2" }),
      }),
      envMemories,
    );
    await expectRateLimitedResponse(ingestSecond);
  });

  it("applies limiter consistently on context/import and resists query-param bypass", async () => {
    const routes: Array<{ path: string; body: unknown; firstStatus: number }> = [
      { path: "/v1/context", body: { user_id: "u1", query: "hello", top_k: 3 }, firstStatus: 200 },
      { path: "/v1/import", body: { artifact_base64: "aGVsbG8=", mode: "upsert" }, firstStatus: 500 },
    ];

    for (const route of routes) {
      const env = makeEnv(1) as unknown as FetchEnv;
      const apiKey = await bootstrapApiKey(env);

      const first = await api.fetch(
        new Request(`http://localhost${route.path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(route.body),
        }),
        env,
      );
      expect(first.status).toBe(route.firstStatus);

      const second = await api.fetch(
        new Request(`http://localhost${route.path}?bypass=true`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(route.body),
        }),
        env,
      );
      await expectRateLimitedResponse(second);
    }
  });

  it("blocks multi-key amplification at workspace scope", async () => {
    const env = makeEnv(50) as unknown as FetchEnv;
    const workspaceId = await bootstrapWorkspace(env);
    const keyA = await bootstrapApiKeyForWorkspace(env, workspaceId, "abuse-key-a");
    const keyB = await bootstrapApiKeyForWorkspace(env, workspaceId, "abuse-key-b");
    const throttledEnv = {
      ...(env as unknown as Record<string, unknown>),
      WORKSPACE_CONCURRENCY_MAX: "1",
      WORKSPACE_CONCURRENCY_TTL_MS: "30000",
    } as unknown as FetchEnv;
    await occupyWorkspaceConcurrencySlot(throttledEnv, workspaceId);

    const [first, second] = await Promise.all([
      api.fetch(
        new Request("http://localhost/v1/search", {
          method: "POST",
          headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json" },
          body: JSON.stringify({ user_id: "u1", query: "hello", top_k: 3 }),
        }),
        throttledEnv,
      ),
      api.fetch(
        new Request("http://localhost/v1/search", {
          method: "POST",
          headers: { authorization: `Bearer ${keyB}`, "content-type": "application/json" },
          body: JSON.stringify({ user_id: "u1", query: "hello", top_k: 3 }),
        }),
        throttledEnv,
      ),
    ]);
    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
  });

  it("caps burst concurrency per workspace in-flight requests", async () => {
    const env = makeEnv(200) as unknown as FetchEnv;
    const workspaceId = await bootstrapWorkspace(env);
    const apiKey = await bootstrapApiKeyForWorkspace(env, workspaceId, "abuse-burst-key");
    const concurrencyEnv = {
      ...(env as unknown as Record<string, unknown>),
      WORKSPACE_CONCURRENCY_MAX: "1",
      WORKSPACE_CONCURRENCY_TTL_MS: "30000",
    } as unknown as FetchEnv;
    await occupyWorkspaceConcurrencySlot(concurrencyEnv, workspaceId);

    const [a, b] = await Promise.all([
      api.fetch(
        new Request("http://localhost/v1/search", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ user_id: "u1", query: "hello", top_k: 3 }),
        }),
        concurrencyEnv,
      ),
      api.fetch(
        new Request("http://localhost/v1/search", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ user_id: "u1", query: "hello", top_k: 3 }),
        }),
        concurrencyEnv,
      ),
    ]);
    expect(a.status).toBe(429);
    expect(b.status).toBe(429);
  });

  it("deduplicates retry spam for same request_id", async () => {
    const env = makeEnv(400) as unknown as FetchEnv;
    const apiKey = await bootstrapApiKey(env);
    const retryRequestId = `retry-${Date.now()}`;

    for (let i = 0; i < 20; i++) {
      const res = await api.fetch(
        new Request("http://localhost/v1/search", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "x-request-id": retryRequestId,
          },
          body: JSON.stringify({ user_id: "u1", query: "hello", top_k: 3 }),
        }),
        env,
      );
      expect(res.status).toBe(200);
    }

    const usageRes = await api.fetch(
      new Request("http://localhost/v1/usage/today", {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      env,
    );
    expect(usageRes.status).toBe(200);
    const usageJson = (await usageRes.json()) as { reads?: number };
    expect(usageJson.reads).toBe(1);
  });
});
