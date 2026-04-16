import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCreateMemory, handleSearch, handleBillingCheckout, handleBillingWebhook } from "../src/index.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

type EventRow = {
  event_name: string;
  workspace_id: string;
  route?: string | null;
  method?: string | null;
  status?: number | null;
};

type SupabaseMock = SupabaseClient & { events: EventRow[] };

function signPayUWebhook(payload: Record<string, string>, env: Record<string, unknown>): string {
  const seq = [
    String(env.PAYU_MERCHANT_SALT ?? ""),
    payload.status ?? "",
    "",
    "",
    "",
    "",
    "",
    payload.udf5 ?? "",
    payload.udf4 ?? "",
    payload.udf3 ?? "",
    payload.udf2 ?? "",
    payload.udf1 ?? "",
    payload.email ?? "",
    payload.firstname ?? "",
    payload.productinfo ?? "",
    payload.amount ?? "",
    payload.txnid ?? "",
    String(env.PAYU_MERCHANT_KEY ?? ""),
  ].join("|");
  return crypto.createHash("sha512").update(seq).digest("hex");
}

function makeSupabase(options?: {
  plan_status?: "free" | "trialing" | "active" | "past_due" | "canceled";
  usage?: { writes: number; reads: number; embeds: number };
}): SupabaseMock {
  const events: EventRow[] = [];
  const usage = options?.usage ?? { writes: 0, reads: 0, embeds: 0 };
  const planStatus = options?.plan_status ?? "free";
  const workspaceRow = {
    id: "ws1",
    plan: "free",
    plan_status: planStatus,
    payu_last_event_created: null,
    payu_last_event_id: null,
    payu_txn_id: null,
    payu_payment_id: null,
    payu_last_status: null,
    payu_last_plan: null,
  } as Record<string, unknown>;
  const payuEvents = new Map<string, Record<string, unknown>>();
  const payuTransactions = new Map<string, Record<string, unknown>>();
  const entitlements: Array<Record<string, unknown>> = [];
  let entitlementId = 1;

  return {
    events,
    from(table: string) {
      if (table === "app_settings") {
        return {
          select: () => ({
            limit: () => ({
              single: async () => ({ data: { api_key_salt: "salt" }, error: null }),
            }),
          }),
        };
      }
      if (table === "api_keys") {
        const builder = {
          eq: () => builder,
          is: () => builder,
          single: async () => ({
            data: { id: "k1", workspace_id: "ws1", workspaces: { plan: "pro", plan_status: planStatus } },
            error: null,
          }),
        };
        return { select: () => builder };
      }
      if (table === "workspaces") {
        const builder = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            if (col === "id") {
              return {
                maybeSingle: async () => ({ data: workspaceRow.id === val ? workspaceRow : null, error: null }),
                single: async () => ({ data: workspaceRow.id === val ? workspaceRow : null, error: null }),
              };
            }
            if (col === "payu_txn_id") {
              return {
                maybeSingle: async () => ({ data: workspaceRow.payu_txn_id === val ? workspaceRow : null, error: null }),
                single: async () => ({ data: workspaceRow.payu_txn_id === val ? workspaceRow : null, error: null }),
              };
            }
            return builder;
          },
          maybeSingle: async () => ({ data: workspaceRow, error: null }),
          single: async () => ({ data: workspaceRow, error: null }),
          update: (fields: Record<string, unknown>) => ({
            eq: () => {
              Object.assign(workspaceRow, fields);
              return { data: [workspaceRow], error: null };
            },
          }),
        };
        return builder;
      }
      if (table === "product_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: events.find((e) => e.event_name), error: null }),
                }),
              }),
            }),
          }),
          insert: (
            rows:
              | Array<{
                  event_name: string;
                  workspace_id: string;
                  route?: string | null;
                  method?: string | null;
                  status?: number | null;
                }>
              | {
                  event_name: string;
                  workspace_id: string;
                  route?: string | null;
                  method?: string | null;
                  status?: number | null;
                },
          ) => {
            const list = Array.isArray(rows) ? rows : [rows];
            list.forEach((r) =>
              events.push({
                event_name: r.event_name,
                workspace_id: r.workspace_id,
                route: r.route ?? null,
                method: r.method ?? null,
                status: r.status ?? null,
              }),
            );
            return { error: null };
          },
        };
      }
      if (table === "payu_webhook_events") {
        return {
          select: () => ({
            eq: (_col: string, val: unknown) => ({
              maybeSingle: async () => ({
                data: payuEvents.get(String(val)) ?? null,
                error: null,
              }),
            }),
          }),
          insert: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const row = list[0];
            return {
              select: () => {
                const run = async () => {
                  if (payuEvents.has(String(row.event_id))) {
                    return { data: null, error: { code: "23505", message: "duplicate" } };
                  }
                  payuEvents.set(String(row.event_id), { ...row });
                  return { data: payuEvents.get(String(row.event_id)) ?? null, error: null };
                };
                return {
                  maybeSingle: run,
                  single: run,
                };
              },
            };
          },
          update: (fields: Record<string, unknown>) => ({
            eq: (_col: string, val: unknown) => {
              const existing = payuEvents.get(String(val));
              if (existing) Object.assign(existing, fields);
              return { data: existing ? [existing] : [], error: null };
            },
          }),
        };
      }
      if (table === "payu_transactions") {
        return {
          select: () => ({
            eq: (_col: string, val: unknown) => ({
              maybeSingle: async () => ({
                data: payuTransactions.get(String(val)) ?? null,
                error: null,
              }),
            }),
          }),
          insert: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const row = list[0];
            if (payuTransactions.has(String(row.txn_id))) {
              return { data: null, error: { code: "23505", message: "duplicate" } };
            }
            payuTransactions.set(String(row.txn_id), { ...row });
            return { data: [row], error: null };
          },
          update: (fields: Record<string, unknown>) => ({
            eq: (_col: string, val: unknown) => {
              const row = payuTransactions.get(String(val));
              if (row) Object.assign(row, fields);
              return { data: row ? [row] : [], error: null };
            },
          }),
        };
      }
      if (table === "workspace_entitlements") {
        const filters: Array<[string, unknown]> = [];
        const applyFilters = () =>
          entitlements.filter((row) => filters.every(([col, val]) => row[col] === val));
        const builder = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return builder;
          },
          order: () => builder,
          limit: (n: number) => ({ data: applyFilters().slice(0, n), error: null }),
          maybeSingle: async () => ({ data: applyFilters()[0] ?? null, error: null }),
          update: (fields: Record<string, unknown>) => ({
            eq: (_col: string, val: unknown) => {
              const row = entitlements.find((entry) => Number(entry.id) === Number(val));
              if (row) Object.assign(row, fields);
              return { data: row ? [row] : [], error: null };
            },
          }),
          insert: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const inserted = list.map((row) => ({ ...row, id: entitlementId++ }));
            entitlements.push(...inserted);
            return { data: inserted, error: null };
          },
        };
        return {
          select: () => builder,
          update: builder.update,
          insert: builder.insert,
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
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "m1" }, error: null }) }) }),
        };
      }
      if (table === "memory_chunks") {
        return { insert: () => ({ error: null }) };
      }
      return { rpc: () => ({ data: [], error: null }) };
    },
    rpc(name: string, params?: Record<string, unknown>) {
      if (name === "bump_usage_rpc" || name === "bump_usage")
        return { data: { writes: usage.writes, reads: usage.reads, embeds: usage.embeds, extraction_calls: 0, embed_tokens_used: 0 }, error: null };
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
        const w = usage.writes;
        const r = usage.reads;
        const e = usage.embeds;
        const et = 0;
        const ex = 0;
        if (w + pW > capW || r + pR > capR || e + pE > capE || et + pEt > capEt || ex + pEx > capEx) {
          return {
            data: [{ workspace_id: "ws1", day: new Date().toISOString().slice(0, 10), writes: w, reads: r, embeds: e, extraction_calls: ex, embed_tokens_used: et, exceeded: true, limit_name: "writes" }],
            error: null,
          };
        }
        usage.writes = w + pW;
        usage.reads = r + pR;
        usage.embeds = e + pE;
        return {
          data: [{ workspace_id: "ws1", day: new Date().toISOString().slice(0, 10), writes: usage.writes, reads: usage.reads, embeds: usage.embeds, extraction_calls: 0, embed_tokens_used: 0, exceeded: false, limit_name: null }],
          error: null,
        };
      }
      return { data: [], error: null };
    },
  } as unknown as SupabaseMock;
}

describe("product events", () => {
  const env = {
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    OPENAI_API_KEY: "",
    API_KEY_SALT: "salt",
    MASTER_ADMIN_TOKEN: "",
    RATE_LIMIT_DO: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ allowed: true, count: 0, reset: Math.floor(Date.now() / 1000) + 60, limit: 100 })),
      }),
    },
    PAYU_MERCHANT_KEY: "payu_key",
    PAYU_MERCHANT_SALT: "payu_salt",
    PAYU_BASE_URL: "https://secure.payu.in/_payment",
    PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice?form=2",
    PAYU_CURRENCY: "INR",
    PAYU_PRO_AMOUNT: "49.00",
    PAYU_PRODUCT_INFO: "MemoryNode Platform",
    PUBLIC_APP_URL: "https://app.example.com",
    EMBEDDINGS_MODE: "stub",
  } as Record<string, unknown>;

  const realFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", realFetch);
  });

  function mockVerify(status: "success" | "failure", paymentId: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ""));
        const txnid = body.get("var1") ?? "txn_upgrade_1";
        return new Response(
          JSON.stringify({
            status: 1,
            transaction_details: {
              [txnid]: {
                txnid,
                status,
                amount: "49.00",
                currency: "INR",
                mihpayid: paymentId,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  }

  it("emits first_ingest_success only once", async () => {
    const supabase = makeSupabase({ usage: { writes: 0, reads: 0, embeds: 0 } });
    const req = new Request("http://localhost/v1/memories", {
      method: "POST",
      headers: { authorization: "Bearer mn_live_x", "content-type": "application/json" },
      body: JSON.stringify({ user_id: "u1", text: "hello" }),
    });
    await handleCreateMemory(req, env, supabase, {}, "req-1");
    await handleCreateMemory(req, env, supabase, {}, "req-2");
    const first = supabase.events.filter((e: EventRow) => e.event_name === "first_ingest_success");
    expect(first.length).toBe(1);
  });

  it("emits cap_exceeded when usage over limit", async () => {
    const supabase = makeSupabase({ usage: { writes: 0, reads: 5000, embeds: 0 }, plan_status: "past_due" });
    const req = new Request("http://localhost/v1/search", {
      method: "POST",
      headers: { authorization: "Bearer mn_live_x", "content-type": "application/json" },
      body: JSON.stringify({ user_id: "u1", query: "test" }),
    });
    const res = await handleSearch(req, env, supabase, {}, "req-cap");
    expect(res.status).toBe(402);
    const cap = supabase.events.find((e: EventRow) => e.event_name === "cap_exceeded");
    expect(cap).toBeTruthy();
  });

  it("emits checkout_started on checkout", async () => {
    const supabase = makeSupabase();
    const res = await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_x" },
      }),
      env,
      supabase,
      {},
      "req-checkout",
    );
    expect(res.status).toBe(200);
    const evt = supabase.events.find((e: EventRow) => e.event_name === "checkout_started");
    expect(evt).toBeTruthy();
  });

  it("emits upgrade_activated when payment becomes successful", async () => {
    const supabase = makeSupabase({ plan_status: "free" });
    const inserted = supabase.from("payu_transactions").insert({
      txn_id: "txn_upgrade_1",
      workspace_id: "ws1",
      plan_code: "pro",
      amount: "49.00",
      currency: "INR",
      status: "initiated",
    });
    expect(inserted.error).toBeNull();
    mockVerify("success", "mih_upgrade_1");
    const payload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_upgrade_1",
      mihpayid: "mih_upgrade_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
      udf2: "pro",
      udf3: "",
      udf4: "",
      udf5: "",
    } as Record<string, string>;
    payload.hash = signPayUWebhook(payload, env);

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      supabase,
      "req-upgrade",
    );
    expect(res.status).toBe(200);
    const evt = supabase.events.find((e: EventRow) => e.event_name === "upgrade_activated");
    expect(evt).toBeTruthy();
  });
});
