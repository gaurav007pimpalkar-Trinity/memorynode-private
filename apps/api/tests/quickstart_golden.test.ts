/**
 * Golden quickstart contract test.
 * These payloads intentionally mirror docs/start-here/README.md curl examples.
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
  API_KEY_SALT: "quickstart-golden-salt",
  MASTER_ADMIN_TOKEN: "admin",
  EMBEDDINGS_MODE: "stub",
  RATE_LIMIT_DO: rateLimitDo as unknown as DurableObjectNamespace,
} satisfies Record<string, unknown>;

async function createWorkspaceApiKey(): Promise<string> {
  const wsRes = await api.fetch(
    new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ name: "quickstart-golden-workspace" }),
    }),
    stubEnv as unknown as Record<string, unknown>,
  );
  expect(wsRes.status).toBe(200);
  const wsJson = await wsRes.json();
  const workspaceId = wsJson.workspace_id as string;
  expect(typeof workspaceId).toBe("string");

  const keyRes = await api.fetch(
    new Request("http://localhost/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ workspace_id: workspaceId, name: "quickstart-golden-key" }),
    }),
    stubEnv as unknown as Record<string, unknown>,
  );
  expect(keyRes.status).toBe(200);
  const keyJson = await keyRes.json();
  return keyJson.api_key as string;
}

describe("golden quickstart payloads", () => {
  it("supports docs quickstart ingest -> search -> context exactly", async () => {
    const apiKey = await createWorkspaceApiKey();
    const authHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    };

    // Mirrors docs/start-here/README.md section 2
    const ingestRes = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          user_id: "user-123",
          namespace: "myapp",
          text: "User prefers dark mode",
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(ingestRes.status).toBe(200);
    const ingestJson = await ingestRes.json();
    expect(ingestJson.stored).toBe(true);
    expect(typeof ingestJson.memory_id).toBe("string");

    // Mirrors docs/start-here/README.md section 3
    const searchRes = await api.fetch(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          user_id: "user-123",
          namespace: "myapp",
          query: "theme preference",
          top_k: 5,
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(searchRes.status).toBe(200);
    const searchJson = await searchRes.json();
    expect(Array.isArray(searchJson.results)).toBe(true);
    expect(typeof searchJson.total).toBe("number");

    // Mirrors docs/start-here/README.md section 4
    const contextRes = await api.fetch(
      new Request("http://localhost/v1/context", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          user_id: "user-123",
          namespace: "myapp",
          query: "What do we know about theme preferences?",
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(contextRes.status).toBe(200);
    const contextJson = await contextRes.json();
    expect(typeof contextJson.context_text).toBe("string");
    expect(Array.isArray(contextJson.citations)).toBe(true);
  });
});
