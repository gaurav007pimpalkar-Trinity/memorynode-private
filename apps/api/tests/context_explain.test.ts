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
  API_KEY_SALT: "context-explain-salt",
  MASTER_ADMIN_TOKEN: "admin",
  EMBEDDINGS_MODE: "stub",
  RATE_LIMIT_DO: rateLimitDo as unknown as DurableObjectNamespace,
} satisfies Record<string, unknown>;

async function issueApiKey(): Promise<string> {
  const wsRes = await api.fetch(
    new Request("http://localhost/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ name: "context-explain-ws" }),
    }),
    stubEnv as unknown as Record<string, unknown>,
  );
  const ws = await wsRes.json();
  const keyRes = await api.fetch(
    new Request("http://localhost/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin" },
      body: JSON.stringify({ workspace_id: ws.workspace_id, name: "context-explain-key" }),
    }),
    stubEnv as unknown as Record<string, unknown>,
  );
  const key = await keyRes.json();
  return key.api_key as string;
}

describe("GET /v1/context/explain", () => {
  it("returns ranking breakdown for retrieved chunks", async () => {
    const apiKey = await issueApiKey();
    const authHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    };

    const ingest = await api.fetch(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          user_id: "u-explain",
          namespace: "demo",
          text: "User prefers dark mode and compact layout.",
          memory_type: "preference",
          importance: 1.4,
        }),
      }),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(ingest.status).toBe(200);

    const res = await api.fetch(
      new Request(
        "http://localhost/v1/context/explain?user_id=u-explain&namespace=demo&query=theme%20preference&top_k=5",
        {
          method: "GET",
          headers: { authorization: `Bearer ${apiKey}` },
        },
      ),
      stubEnv as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.memories_retrieved)).toBe(true);
    expect(Array.isArray(json.chunk_ids_used)).toBe(true);
    expect(Array.isArray(json.results)).toBe(true);
    if ((json.results as unknown[]).length > 0) {
      const first = json.results[0] as {
        scores: {
          relevance_score: number;
          recency_score: number;
          importance_score: number;
          final_score: number;
        };
        ordering_explanation: string;
      };
      expect(typeof first.scores.relevance_score).toBe("number");
      expect(typeof first.scores.recency_score).toBe("number");
      expect(typeof first.scores.importance_score).toBe("number");
      expect(typeof first.scores.final_score).toBe("number");
      expect(typeof first.ordering_explanation).toBe("string");
    }
  });
});
