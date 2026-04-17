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
});
