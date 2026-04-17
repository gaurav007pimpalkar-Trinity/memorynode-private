/**
 * Plan v2 protection layer integration tests.
 * Covers: extraction cap, token cap, atomic cap enforcement, import cap, workspace RPM.
 */

import { describe, expect, it } from "vitest";
import {
  handleCreateMemory,
  handleSearch,
  handleImport,
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
  const reservations: Array<{
    id: string;
    request_id: string;
    writes_delta: number;
    reads_delta: number;
    embeds_delta: number;
    embed_tokens_delta: number;
    extraction_calls_delta: number;
    status: "reserved" | "committed";
  }> = [];

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
      if (table === "workspace_entitlements") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({
                  data: [{ plan_code: planCode, status: "active", starts_at: null, expires_at: null, caps_json: null }],
                  error: null,
                }),
              }),
            }),
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
      if (name === "reserve_usage_if_within_cap") {
        const requestId = String(params?.p_request_id ?? "");
        const existing = reservations.find((r) => r.request_id === requestId);
        if (existing) {
          return {
            data: [{ reservation_id: existing.id, exceeded: false, limit_name: null, used_value: 0, cap_value: 0 }],
            error: null,
          };
        }
        const pW = (params?.p_writes_delta as number) ?? 0;
        const pR = (params?.p_reads_delta as number) ?? 0;
        const pE = (params?.p_embeds_delta as number) ?? 0;
        const pEt = (params?.p_embed_tokens_delta as number) ?? 0;
        const pEx = (params?.p_extraction_calls_delta as number) ?? 0;
        const capW = (params?.p_writes_cap as number) ?? 0;
        const capR = (params?.p_reads_cap as number) ?? 0;
        const capE = (params?.p_embeds_cap as number) ?? 0;
        const capEt = (params?.p_embed_tokens_cap as number) ?? 0;
        const capEx = (params?.p_extraction_calls_cap as number) ?? 0;
        if (usage.writes + pW > capW) return { data: [{ reservation_id: null, exceeded: true, limit_name: "writes", used_value: usage.writes, cap_value: capW }], error: null };
        if (usage.reads + pR > capR) return { data: [{ reservation_id: null, exceeded: true, limit_name: "reads", used_value: usage.reads, cap_value: capR }], error: null };
        if (usage.embeds + pE > capE) return { data: [{ reservation_id: null, exceeded: true, limit_name: "embeds", used_value: usage.embeds, cap_value: capE }], error: null };
        if (usage.embed_tokens_used + pEt > capEt) return { data: [{ reservation_id: null, exceeded: true, limit_name: "embed_tokens", used_value: usage.embed_tokens_used, cap_value: capEt }], error: null };
        if (usage.extraction_calls + pEx > capEx) return { data: [{ reservation_id: null, exceeded: true, limit_name: "extraction_calls", used_value: usage.extraction_calls, cap_value: capEx }], error: null };
        const id = `res-${reservations.length + 1}`;
        reservations.push({
          id,
          request_id: requestId,
          writes_delta: pW,
          reads_delta: pR,
          embeds_delta: pE,
          embed_tokens_delta: pEt,
          extraction_calls_delta: pEx,
          status: "reserved",
        });
        return {
          data: [{ reservation_id: id, exceeded: false, limit_name: null, used_value: 0, cap_value: 0 }],
          error: null,
        };
      }
      if (name === "commit_usage_reservation") {
        const reservationId = String(params?.p_reservation_id ?? "");
        const row = reservations.find((r) => r.id === reservationId);
        if (!row) return { data: false, error: null };
        if (row.status === "committed") return { data: true, error: null };
        row.status = "committed";
        usage.writes += row.writes_delta;
        usage.reads += row.reads_delta;
        usage.embeds += row.embeds_delta;
        usage.embed_tokens_used += row.embed_tokens_delta;
        usage.extraction_calls += row.extraction_calls_delta;
        return { data: true, error: null };
      }
      if (name === "bump_usage_if_within_cap" || name === "record_usage_event_if_within_cap") {
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
  it("returns 402 daily_cap_exceeded when extract=true and plan has extraction_calls_per_day 0", async () => {
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
    expect(json.error?.code).toBe("daily_cap_exceeded");
    expect(json.error?.limit).toBe("extraction_calls");
    expect(json.error?.cap).toBe(0);
  });
});

describe("Plan v2: token cap enforcement", () => {
  it("returns 402 daily_cap_exceeded when embed_tokens would exceed plan cap", async () => {
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
    expect(json.error?.code).toBe("daily_cap_exceeded");
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
    expect(json.error?.code).toBe("daily_cap_exceeded");
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
    expect(json.error?.code).toBe("daily_cap_exceeded");
    expect(json.error?.limit).toBe("reads");
  });
});

describe("Plan v2: import cap enforcement", () => {
  it("returns 402 when import would exceed writes cap", async () => {
    const crypto = await import("node:crypto");
    const limits = getLimitsForPlanCode("build");
    const supabase = makeSupabasePlanV2({
      planCode: "build",
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
    expect(json.error?.code).toBe("daily_cap_exceeded");
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

describe("Plan v2: workspace in-flight concurrency", () => {
  it("returns 429 when parallel requests exceed workspace in-flight cap", async () => {
    const doStub = makeRateLimitDoStub(100, 60_000);
    const env = makeEnv({
      RATE_LIMIT_DO: doStub,
      WORKSPACE_CONCURRENCY_MAX: "1",
      WORKSPACE_CONCURRENCY_TTL_MS: "30000",
    });
    const supabase = makeSupabasePlanV2({
      planCode: "free",
      usage: { writes: 0, reads: 0, embeds: 0, extraction_calls: 0, embed_tokens_used: 0 },
    });

    const makeReq = (requestId: string) =>
      handleSearch(
        new Request("http://localhost/v1/search", {
          method: "POST",
          headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
          body: JSON.stringify({ user_id: "u1", query: "q" }),
        }),
        env as Record<string, unknown>,
        supabase,
        {},
        requestId,
      );

    const ns = (env as Record<string, unknown>).RATE_LIMIT_DO as {
      idFromName: (name: string) => string;
      get: (id: string) => { fetch: (request: Request) => Promise<Response> };
    };
    const held = await ns.get(ns.idFromName("conc-ws:ws1")).fetch(
      new Request("https://rate-limit/concurrency", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "concurrency_acquire",
          limit: 1,
          ttl_ms: 30_000,
          token: "occupied-ws1",
        }),
      }),
    );
    expect(held.status).toBe(200);

    const [a, b] = await Promise.all([makeReq("req-c-1"), makeReq("req-c-2")]);
    expect(a.status).toBe(429);
    expect(b.status).toBe(429);
  });
});

describe("Plan v2: error shape", () => {
  it("returns consistent daily_cap_exceeded with limit, used, cap", async () => {
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
    expect(json.error.code).toBe("daily_cap_exceeded");
    expect(typeof json.error.limit).toBe("string");
    expect(typeof json.error.used).toBe("number");
    expect(typeof json.error.cap).toBe("number");
  });
});
