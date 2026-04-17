import { describe, expect, it } from "vitest";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import api from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateLimitDo = makeRateLimitDoStub();

const env = {
  SUPABASE_MODE: "stub",
  SUPABASE_URL: "stub",
  SUPABASE_SERVICE_ROLE_KEY: "stub",
  OPENAI_API_KEY: "sk-stub",
  API_KEY_SALT: "tenant-isolation-salt",
  MASTER_ADMIN_TOKEN: "admin",
  EMBEDDINGS_MODE: "stub",
  RATE_LIMIT_DO: rateLimitDo as unknown as DurableObjectNamespace,
} satisfies Record<string, unknown>;

async function createWorkspaceAndKey(name: string): Promise<{ workspaceId: string; apiKey: string }> {
  const wsRes = await api.fetch(
    new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ name }),
    }),
    env as unknown as Record<string, unknown>,
  );
  expect(wsRes.status).toBe(200);
  const ws = await wsRes.json();
  const workspaceId = String(ws.workspace_id);

  const keyRes = await api.fetch(
    new Request("http://localhost/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ workspace_id: workspaceId, name: `${name}-key` }),
    }),
    env as unknown as Record<string, unknown>,
  );
  expect(keyRes.status).toBe(200);
  const key = await keyRes.json();
  return { workspaceId, apiKey: String(key.api_key) };
}

describe("memory endpoints enforce workspace tenant isolation", () => {
  it("prevents workspace B from reading workspace A memory by id", async () => {
    const a = await createWorkspaceAndKey("tenant-a");
    const b = await createWorkspaceAndKey("tenant-b");

    const createRes = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a.apiKey}` },
        body: JSON.stringify({ user_id: "user-a", namespace: "default", text: "A-private-memory" }),
      }),
      env as unknown as Record<string, unknown>,
    );
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    const memoryId = String(created.memory_id);

    const readAsB = await api.fetch(
      new Request(`http://localhost/v1/memories/${memoryId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${b.apiKey}` },
      }),
      env as unknown as Record<string, unknown>,
    );
    expect(readAsB.status).toBe(404);
  });

  it("does not leak workspace A memory via list in workspace B", async () => {
    const a = await createWorkspaceAndKey("tenant-list-a");
    const b = await createWorkspaceAndKey("tenant-list-b");

    const createRes = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a.apiKey}` },
        body: JSON.stringify({ user_id: "user-a", namespace: "default", text: "A-list-private-memory" }),
      }),
      env as unknown as Record<string, unknown>,
    );
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    const memoryId = String(created.memory_id);

    const listAsB = await api.fetch(
      new Request("http://localhost/v1/memories?page=1&page_size=50", {
        method: "GET",
        headers: { authorization: `Bearer ${b.apiKey}` },
      }),
      env as unknown as Record<string, unknown>,
    );
    expect(listAsB.status).toBe(200);
    const body = await listAsB.json();
    const ids = Array.isArray(body.results) ? body.results.map((r: { id?: string }) => String(r.id ?? "")) : [];
    expect(ids).not.toContain(memoryId);
  });
});
