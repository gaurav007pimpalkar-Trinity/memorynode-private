/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, expect, it } from "vitest";
import { deleteMemoryCascade, performSearch } from "../src/index.js";

type ChunkRow = {
  id: string;
  workspace_id: string;
  memory_id: string;
  user_id: string;
  namespace: string;
  chunk_text: string;
  chunk_index: number;
};

const uniqueText = "unique-delete-safety-XYZ";

function makeStore() {
  return {
    memory_chunks: [
      {
        id: "chunk1",
        workspace_id: "ws1",
        memory_id: "mem1",
        user_id: "user1",
        namespace: "default",
        chunk_text: uniqueText,
        chunk_index: 0,
      } satisfies ChunkRow,
    ],
    memories: [
      {
        id: "mem1",
        workspace_id: "ws1",
        user_id: "user1",
        namespace: "default",
        text: uniqueText,
        metadata: {},
        created_at: new Date().toISOString(),
      },
    ],
    usage_daily: [],
  };
}

function makeSupabase(store: ReturnType<typeof makeStore>) {
  return {
    rpc(name: string, args: Record<string, any>) {
      if (name === "delete_memory_scoped") {
        const workspaceId = String(args.p_workspace_id);
        const memoryId = String(args.p_memory_id);
        const before = store.memories.length;
        store.memory_chunks = store.memory_chunks.filter(
          (row) => !(row.workspace_id === workspaceId && row.memory_id === memoryId),
        );
        store.memories = store.memories.filter(
          (row) => !(row.workspace_id === workspaceId && row.id === memoryId),
        );
        return Promise.resolve({ data: [{ deleted: store.memories.length < before }], error: null });
      }
      if (name === "match_chunks_vector" || name === "match_chunks_text") {
        const rows = store.memory_chunks.filter(
          (c) =>
            c.workspace_id === args.p_workspace_id &&
            c.user_id === args.p_user_id &&
            c.namespace === args.p_namespace,
        );
        return Promise.resolve({ data: rows, error: null });
      }
      if (name === "bump_usage_rpc" || name === "bump_usage") {
        return Promise.resolve({
          data: {
            workspace_id: args.p_workspace_id,
            day: args.p_day,
            writes: 0,
            reads: 0,
            embeds: 0,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table: "usage_daily" | "memories" | "memory_chunks") {
      const builder: any = {
        filters: [] as Array<{ col: string; val: any }>,
        delete: (_opts?: { count?: string }) => {
          const delBuilder: any = {
            count: 0,
            error: null,
            totalRemoved: 0,
            eq: (col: string, val: any) => {
              const before = (store as any)[table].length;
              (store as any)[table] = (store as any)[table].filter((row: any) => row[col] !== val);
              const removed = before - (store as any)[table].length;
              delBuilder.totalRemoved += removed;
              delBuilder.count = delBuilder.totalRemoved;
              return delBuilder;
            },
          };
          return delBuilder;
        },
        select: () => builder,
        update: (_data: Record<string, unknown>) => ({
          eq: (_c: string, _v: unknown) => ({
            in: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
        eq: (col: string, val: any) => {
          builder.filters.push({ col, val });
          return builder;
        },
        maybeSingle: () => {
          const row = (store as any)[table].find((r: any) =>
            builder.filters.every((f: any) => r[f.col] === f.val),
          );
          return Promise.resolve({ data: row ?? null, error: null });
        },
        order: () => builder,
        range: () => builder,
        contains: () => builder,
        gte: () => builder,
        lte: () => builder,
      };
      return builder;
    },
  };
}

const envStub = {
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OPENAI_API_KEY: "",
  API_KEY_SALT: "",
  MASTER_ADMIN_TOKEN: "",
  EMBEDDINGS_MODE: "stub",
  RATE_LIMIT_DO: {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async () =>
        new Response(JSON.stringify({ allowed: true, count: 1, limit: 100, reset: 0 }), { status: 200 }),
    }),
  } as any,
};

describe("deleteMemoryCascade removes search/context visibility", () => {
  it("search/context no longer return deleted memory", async () => {
    const store = makeStore();
    const supabase = makeSupabase(store);
    const auth = { workspaceId: "ws1", keyHash: "k", plan: "free" } as const;

    // Before delete: should find the unique text via search
    const beforeSearch = await performSearch(
      auth,
      { user_id: "user1", namespace: "default", query: "unique", top_k: 5 },
      envStub,
      supabase as any,
    );
    expect(beforeSearch.results.length).toBeGreaterThan(0);
    expect(beforeSearch.results.some((r) => r.memory_id === "mem1")).toBe(true);
    expect(beforeSearch.results.some((r) => r.text.includes(uniqueText))).toBe(true);

    // Delete memory
    const deleted = await deleteMemoryCascade(supabase as any, "ws1", "mem1");
    expect(deleted).toBe(true);

    // After delete: search returns nothing
    const afterSearch = await performSearch(
      auth,
      { user_id: "user1", namespace: "default", query: "unique", top_k: 5 },
      envStub,
      supabase as any,
    );
    expect(afterSearch.results.length).toBe(0);

    // Context should also return empty
    const afterContext = await performSearch(
      auth,
      { user_id: "user1", namespace: "default", query: "unique", top_k: 5 },
      envStub,
      supabase as any,
    );
    expect(afterContext.results.length).toBe(0);
  });
});
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
