/**
 * Minimal integration tests for API endpoints: memories, search, import gating.
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

describe("memory importance & retrieval_count (stub)", () => {
  it("persists importance and increments retrieval_count after search", async () => {
    const { apiKey } = await getStubApiKey();
    const auth = { authorization: `Bearer ${apiKey}` };
    const token = "retrievalcountuniq999";
    const insertRes = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          user_id: "u-rc",
          text: `Hold the ${token} marker for retrieval stats`,
          namespace: "default",
          importance: 4,
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(insertRes.status).toBe(200);
    const inserted = await insertRes.json();
    const memoryId = inserted.memory_id as string;

    let getRes = await api.fetch(new Request(`http://localhost/v1/memories/${memoryId}`, { headers: auth }), stubEnv as unknown as Record<string, unknown>);
    expect(getRes.status).toBe(200);
    let mem = await getRes.json();
    expect(mem.importance).toBe(4);
    expect(Number(mem.retrieval_count ?? 0)).toBe(0);

    const searchRes = await api.fetch(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ user_id: "u-rc", query: token, top_k: 10 }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(searchRes.status).toBe(200);

    getRes = await api.fetch(new Request(`http://localhost/v1/memories/${memoryId}`, { headers: auth }), stubEnv as unknown as Record<string, unknown>);
    expect(getRes.status).toBe(200);
    mem = await getRes.json();
    expect(Number(mem.retrieval_count ?? 0)).toBeGreaterThanOrEqual(1);
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

describe("POST /v1/import", () => {
  it("returns 500 for invalid artifact payload", async () => {
    const { apiKey } = await getStubApiKey();
    const res = await api.fetch(
      new Request("http://localhost/v1/import", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          artifact_base64: "aGVsbG8=",
          mode: "upsert",
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json?.error?.code).toBe("INTERNAL");
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

describe("eval API (stub)", () => {
  it("creates set, item, runs eval, lists, deletes", async () => {
    const { apiKey } = await getStubApiKey();
    const auth = { authorization: `Bearer ${apiKey}` };
    const userId = "eval-user-int";

    const memRes = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          user_id: userId,
          text: "evaluniqtoken987654321 context for retrieval test",
          namespace: "default",
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(memRes.status).toBe(200);
    const memJson = await memRes.json();
    const memoryId = memJson.memory_id as string;
    expect(typeof memoryId).toBe("string");

    const setRes = await api.fetch(
      new Request("http://localhost/v1/evals/sets", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ name: "integration-eval-set" }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(setRes.status).toBe(201);
    const setJson = await setRes.json();
    const evalSetId = setJson.eval_set?.id as string;
    expect(typeof evalSetId).toBe("string");

    const itemRes = await api.fetch(
      new Request("http://localhost/v1/evals/items", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          eval_set_id: evalSetId,
          query: "evaluniqtoken987654321",
          expected_memory_ids: [memoryId],
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(itemRes.status).toBe(201);
    const itemJson = await itemRes.json();
    const evalItemId = itemJson.eval_item?.id as string;
    expect(typeof evalItemId).toBe("string");

    const listSets = await api.fetch(
      new Request("http://localhost/v1/evals/sets", { method: "GET", headers: auth }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(listSets.status).toBe(200);
    const listSetsJson = await listSets.json();
    expect(Array.isArray(listSetsJson.eval_sets)).toBe(true);
    expect(listSetsJson.eval_sets.some((s: { id: string }) => s.id === evalSetId)).toBe(true);

    const listItems = await api.fetch(
      new Request(`http://localhost/v1/evals/items?eval_set_id=${encodeURIComponent(evalSetId)}`, {
        method: "GET",
        headers: auth,
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(listItems.status).toBe(200);
    const listItemsJson = await listItems.json();
    expect(listItemsJson.eval_items?.length).toBeGreaterThanOrEqual(1);

    const runRes = await api.fetch(
      new Request("http://localhost/v1/evals/run", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          eval_set_id: evalSetId,
          user_id: userId,
          search_mode: "keyword",
          top_k: 5,
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(runRes.status).toBe(200);
    const runJson = await runRes.json();
    expect(runJson.eval_set_id).toBe(evalSetId);
    expect(runJson.item_count).toBe(1);
    expect(typeof runJson.avg_precision_at_k).toBe("number");
    expect(typeof runJson.avg_recall).toBe("number");
    expect(Array.isArray(runJson.items)).toBe(true);
    expect(runJson.items[0].eval_item_id).toBe(evalItemId);
    expect(typeof runJson.items[0].precision_at_k).toBe("number");
    expect(typeof runJson.items[0].recall).toBe("number");

    const delItem = await api.fetch(
      new Request(`http://localhost/v1/evals/items/${encodeURIComponent(evalItemId)}`, {
        method: "DELETE",
        headers: auth,
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(delItem.status).toBe(200);

    const delSet = await api.fetch(
      new Request(`http://localhost/v1/evals/sets/${encodeURIComponent(evalSetId)}`, {
        method: "DELETE",
        headers: auth,
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(delSet.status).toBe(200);
  });

  it("returns 400 for invalid eval item payload", async () => {
    const { apiKey } = await getStubApiKey();
    const res = await api.fetch(
      new Request("http://localhost/v1/evals/items", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ eval_set_id: "not-a-uuid", query: "x", expected_memory_ids: [] }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json?.error?.code).toBe("BAD_REQUEST");
  });
});
