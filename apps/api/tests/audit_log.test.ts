/**
 * GET /v1/audit/log — tenant audit trail (stub Supabase).
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
  API_KEY_SALT: "audit-log-salt",
  MASTER_ADMIN_TOKEN: "admin",
  EMBEDDINGS_MODE: "stub",
  RATE_LIMIT_DO: rateLimitDo as unknown as DurableObjectNamespace,
} satisfies Record<string, unknown>;

async function getStubApiKey(): Promise<{ apiKey: string }> {
  const wsRes = await api.fetch(
    new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ name: "audit-ws" }),
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
      body: JSON.stringify({ workspace_id: workspaceId, name: "audit-key" }),
    }),
    stubEnv as unknown as Record<string, unknown>,
  );
  expect(keyRes.status).toBe(200);
  const keyJson = await keyRes.json();
  return { apiKey: keyJson.api_key as string };
}

describe("GET /v1/audit/log", () => {
  it("returns 200 with entries, page, limit, has_more", async () => {
    const { apiKey } = await getStubApiKey();
    const res = await api.fetch(
      new Request("http://localhost/v1/audit/log?limit=20&page=1", {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      entries: unknown[];
      page: number;
      limit: number;
      has_more: boolean;
    };
    expect(Array.isArray(json.entries)).toBe(true);
    expect(json.page).toBe(1);
    expect(json.limit).toBe(20);
    expect(typeof json.has_more).toBe("boolean");
  });

  it("GET /v1/usage/today includes operational_mode", async () => {
    const { apiKey } = await getStubApiKey();
    const res = await api.fetch(
      new Request("http://localhost/v1/usage/today", {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { operational_mode?: string };
    expect(json.operational_mode).toMatch(/^(normal|degraded|sleep)$/);
  });
});
