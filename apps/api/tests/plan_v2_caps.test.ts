/**
 * Plan v2 protection layer integration tests.
 * Covers: extraction cap, token cap, atomic cap enforcement, import cap, eval cap, workspace RPM.
 */

import { describe, expect, it } from "vitest";
import {
  handleCreateMemory,
  handleSearch,
  handleImport,
  handleRunEval,
} from "../src/index.js";
import { getLimitsForPlanCode } from "@memorynodeai/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateLimitDo = makeRateLimitDoStub(100, 60_000);

function makeEnv(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    OPENAI_API_KEY: "",
    API_KEY_SALT: "salt",
    MASTER_ADMIN_TOKEN: "",
    RATE_LIMIT_DO: rateLimitDo,
    EMBEDDINGS_MODE: "stub",
    ...overrides,
  };
}

type UsageState = {
  writes: number;
  reads: number;
  embeds: number;
  extraction_calls: number;
  embed_tokens_used: number;
};

function makeSupabasePlanV2(options: {
  planCode?: string;
  usage?: Partial<UsageState>;
}) {
  const planCode = options.planCode ?? "free";
  void getLimitsForPlanCode(planCode);
  const usage: UsageState = {
    writes: options.usage?.writes ?? 0,
    reads: options.usage?.reads ?? 0,
    embeds: options.usage?.embeds ?? 0,
    extraction_calls: options.usage?.extraction_calls ?? 0,
    embed_tokens_used: options.usage?.embed_tokens_used ?? 0,
  };

  return {
    from(table: string) {
      if (table === "app_settings") {
        return {
          select: () => ({ limit: () => ({ single: async () => ({ data: { api_key_salt: "salt" }, error: null }) }) }),
        };
      }
      if (table === "api_keys") {
        return {
          select: () => ({
            eq: () => ({ is: () => ({ single: async () => ({ data: { id: "k1", workspace_id: "ws1", workspaces: { plan: planCode, plan_status: "active" } }, error: null }) }) }),
          }),
        };
      }
      if (table === "workspaces") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { id: "ws1", plan: planCode, plan_status: "active" }, error: null }) }),
          }),
        };
      }
      if (table === "usage_daily") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: usage, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "memories") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "mem-1" }, error: null }) }) }),
        };
      }
      if (table === "memory_chunks") {
        return { insert: () => ({ error: null }) };
      }
      if (table === "eval_sets") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: "es1", workspace_id: "ws1" }, error: null }),
            }),
          }),
        };
      }
      if (table === "eval_items") {
        return {
          select: () => ({
            eq: () => ({
              order: () =>
                Promise.resolve({
                  data: Array.from({ length: 5 }, (_, i) => ({ id: `item-${i}`, query: "q", expected_memory_ids: [] })),
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "product_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
          insert: () => ({ error: null }),
        };
      }
      return {};
    },
    rpc(name: string, params?: Record<string, unknown>) {
      if (name === "bump_usage_if_within_cap") {
        const pW = (params?.p_writes as number) ?? 0;
        const pR = (params?.p_reads as number) ?? 0;
        const pE = (params?.p_embeds as number) ?? 0;
        const pEt = (params?.p_embed_tokens as number) ?? 0;
        const pEx = (params?.p_extraction_calls as number) ?? 0;
        const capW = (params?.p_writes_cap as number) ?? 0;
        const capR = (params?.p_reads_cap as number) ?? 0;
        const capE = (params?.p_embeds_cap as number) ?? 0;
        const capEt = (params?.p_embed_tokens_cap as number) ?? 0;
        const capEx = (params?.p_extraction_calls_cap as number) ?? 0;
        if (usage.writes + pW > capW) {
          return { data: [{ ...usage, exceeded: true, limit_name: "writes" }], error: null };
        }
        if (usage.reads + pR > capR) {
          return { data: [{ ...usage, exceeded: true, limit_name: "reads" }], error: null };
        }
        if (usage.embeds + pE > capE) {
          return { data: [{ ...usage, exceeded: true, limit_name: "embeds" }], error: null };
        }
        if (usage.embed_tokens_used + pEt > capEt) {
          return { data: [{ ...usage, exceeded: true, limit_name: "embed_tokens" }], error: null };
        }
        if (usage.extraction_calls + pEx > capEx) {
          return { data: [{ ...usage, exceeded: true, limit_name: "extraction_calls" }], error: null };
        }
        usage.writes += pW;
        usage.reads += pR;
        usage.embeds += pE;
        usage.embed_tokens_used += pEt;
        usage.extraction_calls += pEx;
        return { data: [{ ...usage, exceeded: false, limit_name: null }], error: null };
      }
      if (name === "match_chunks_vector" || name === "match_chunks_text") {
        return { data: [], error: null };
      }
      return { data: [], error: null };
    },
  } as unknown as SupabaseClient;
}

describe("Plan v2: extraction cap enforcement", () => {
  it("returns 402 PLAN_LIMIT_EXCEEDED when extract=true and plan has extraction_calls_per_day 0", async () => {
    const supabase = makeSupabasePlanV2({ planCode: "free" });
    const res = await handleCreateMemory(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", text: "Short text", extract: true }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase,
      {},
    );
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error?.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(json.error?.limit).toBe("extraction_calls");
    expect(json.error?.cap).toBe(0);
  });
});

describe("Plan v2: token cap enforcement", () => {
  it("returns 402 PLAN_LIMIT_EXCEEDED when embed_tokens would exceed plan cap", async () => {
    const limits = getLimitsForPlanCode("free");
    const supabase = makeSupabasePlanV2({
      planCode: "free",
      usage: { writes: 0, reads: 0, embeds: 0, extraction_calls: 0, embed_tokens_used: limits.embed_tokens_per_day - 10 },
    });
    const res = await handleCreateMemory(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", text: "x".repeat(1000) }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase,
      {},
    );
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error?.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(json.error?.limit).toBe("embed_tokens");
  });
});

describe("Plan v2: atomic cap enforcement", () => {
  it("returns 402 when writes at cap and another write is attempted", async () => {
    const limits = getLimitsForPlanCode("free");
    const supabase = makeSupabasePlanV2({
      planCode: "free",
      usage: { writes: limits.writes_per_day, reads: 0, embeds: 0, extraction_calls: 0, embed_tokens_used: 0 },
    });
    const res = await handleCreateMemory(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", text: "one more" }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase,
      {},
    );
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error?.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(json.error?.limit).toBe("writes");
  });

  it("returns 402 when reads at cap and search is attempted", async () => {
    const limits = getLimitsForPlanCode("free");
    const supabase = makeSupabasePlanV2({
      planCode: "free",
      usage: { writes: 0, reads: limits.reads_per_day, embeds: 0, extraction_calls: 0, embed_tokens_used: 0 },
    });
    const res = await handleSearch(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", query: "test" }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase,
      {},
      "req-1",
    );
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error?.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(json.error?.limit).toBe("reads");
  });
});

describe("Plan v2: import cap enforcement", () => {
  it("returns 402 when import would exceed writes cap", async () => {
    const crypto = await import("node:crypto");
    const limits = getLimitsForPlanCode("free");
    const supabase = makeSupabasePlanV2({
      planCode: "free",
      usage: { writes: limits.writes_per_day - 5, reads: 0, embeds: 0, extraction_calls: 0, embed_tokens_used: 0 },
    });
    const memories = Array.from({ length: 20 }, (_, i) => ({
      id: `mem-${i}`,
      workspace_id: "ws1",
      user_id: "u1",
      namespace: "default",
      text: "t",
      metadata: {},
      created_at: new Date().toISOString(),
      memory_type: "user",
      source_memory_id: null,
      duplicate_of: null,
    }));
    const chunks = memories.map((m, i) => ({
      id: `chunk-${i}`,
      memory_id: m.id,
      workspace_id: "ws1",
      user_id: "u1",
      namespace: "default",
      chunk_index: 0,
      chunk_text: "x",
      embedding: null,
      created_at: new Date().toISOString(),
    }));
    const memNdjson = memories.map((m) => JSON.stringify(m)).join("\n");
    const chunkNdjson = chunks.map((c) => JSON.stringify(c)).join("\n");
    const memBytes = new TextEncoder().encode(memNdjson);
    const chunkBytes = new TextEncoder().encode(chunkNdjson);
    const memSha = crypto.createHash("sha256").update(memBytes).digest("hex");
    const chunkSha = crypto.createHash("sha256").update(chunkBytes).digest("hex");
    const manifest = {
      version: 1,
      workspace_id: "ws1",
      files: [
        { name: "memories.ndjson", sha256: memSha, size: memBytes.length },
        { name: "chunks.ndjson", sha256: chunkSha, size: chunkBytes.length },
      ],
    };
    const zip = await import("jszip").then((m) => m.default);
    const jzip = new zip();
    jzip.file("manifest.json", JSON.stringify(manifest));
    jzip.file("memories.ndjson", memNdjson);
    jzip.file("chunks.ndjson", chunkNdjson);
    const artifactBase64 = Buffer.from(await jzip.generateAsync({ type: "arraybuffer" })).toString("base64");

    const res = await handleImport(
      new Request("http://localhost/v1/import", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ artifact_base64: artifactBase64, mode: "upsert" }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase,
      {},
    );
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error?.code).toBe("PLAN_LIMIT_EXCEEDED");
  });
});

describe("Plan v2: eval cap enforcement", () => {
  it("returns 402 when eval run would exceed reads/embeds cap", async () => {
    const limits = getLimitsForPlanCode("free");
    const embedsCap = Math.floor(limits.embed_tokens_per_day / 200);
    const supabase = makeSupabasePlanV2({
      planCode: "free",
      usage: { writes: 0, reads: limits.reads_per_day - 1, embeds: embedsCap - 1, extraction_calls: 0, embed_tokens_used: 0 },
    });
    const res = await handleRunEval(
      new Request("http://localhost/v1/eval/run", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ eval_set_id: "es1", user_id: "u1", namespace: "default" }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase,
      {},
      "req-1",
    );
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error?.code).toBe("PLAN_LIMIT_EXCEEDED");
  });
});

describe("Plan v2: workspace RPM", () => {
  it("returns 429 when workspace rate limit exceeded", async () => {
    const wsRpm = 2;
    const doStub = makeRateLimitDoStub(wsRpm, 60_000);
    const env = makeEnv({ RATE_LIMIT_DO: doStub });
    const supabase = makeSupabasePlanV2({ planCode: "free", usage: { writes: 0, reads: 0, embeds: 0, extraction_calls: 0, embed_tokens_used: 0 } });

    const req = () =>
      handleSearch(
        new Request("http://localhost/v1/search", {
          method: "POST",
          headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
          body: JSON.stringify({ user_id: "u1", query: "q" }),
        }),
        env as Record<string, unknown>,
        supabase,
        {},
        "req-1",
      );

    const r1 = await req();
    expect(r1.status).toBe(200);
    const r2 = await req();
    expect(r2.status).toBe(200);
    const r3 = await req();
    expect(r3.status).toBe(429);
    const json = await r3.json();
    expect(json.error?.code).toBe("rate_limited");
  });
});

describe("Plan v2: error shape", () => {
  it("returns consistent PLAN_LIMIT_EXCEEDED with limit, used, cap", async () => {
    const limits = getLimitsForPlanCode("free");
    const supabase = makeSupabasePlanV2({
      planCode: "free",
      usage: { writes: limits.writes_per_day, reads: 0, embeds: 0, extraction_calls: 0, embed_tokens_used: 0 },
    });
    const res = await handleCreateMemory(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", text: "x" }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase,
      {},
    );
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(typeof json.error.limit).toBe("string");
    expect(typeof json.error.used).toBe("number");
    expect(typeof json.error.cap).toBe("number");
  });
});
