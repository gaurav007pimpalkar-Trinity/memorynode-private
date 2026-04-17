/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, expect, it } from "vitest";
import { deleteMemoryCascade, normalizeMemoryListParams } from "../src/index.js";

describe("normalizeMemoryListParams", () => {
  it("defaults page/page_size and clamps", () => {
    const url = new URL("http://localhost/v1/memories");
    const params = normalizeMemoryListParams(url);
    expect(params.page).toBe(1);
    expect(params.page_size).toBeGreaterThan(0);
  });

  it("parses metadata and time filters", () => {
    const url = new URL(
      "http://localhost/v1/memories?metadata=%7B%22topic%22%3A%22ai%22%7D&start_time=2024-01-01T00:00:00Z&end_time=2024-02-01T00:00:00Z&page=2&page_size=5&namespace=ns&user_id=user1",
    );
    const params = normalizeMemoryListParams(url);
    expect(params.page).toBe(2);
    expect(params.page_size).toBe(5);
    expect(params.namespace).toBe("ns");
    expect(params.user_id).toBe("user1");
    expect(params.filters.metadata?.topic).toBe("ai");
    expect(params.filters.start_time?.startsWith("2024-01-01")).toBe(true);
    expect(params.filters.end_time?.startsWith("2024-02-01")).toBe(true);
  });

  it("rejects bad metadata json", () => {
    const url = new URL("http://localhost/v1/memories?metadata=notjson");
    expect(() => normalizeMemoryListParams(url)).toThrow();
  });

  it("parses valid memory_type filter", () => {
    const url = new URL("http://localhost/v1/memories?memory_type=fact");
    const params = normalizeMemoryListParams(url);
    expect(params.memory_type).toBe("fact");
  });

  it("rejects invalid memory_type", () => {
    const url = new URL("http://localhost/v1/memories?memory_type=invalid");
    expect(() => normalizeMemoryListParams(url)).toThrow("memory_type must be one of");
  });

  it("accepts all valid memory_type values", () => {
    for (const mt of ["fact", "preference", "event", "note"]) {
      const url = new URL(`http://localhost/v1/memories?memory_type=${mt}`);
      const params = normalizeMemoryListParams(url);
      expect(params.memory_type).toBe(mt);
    }
  });
});

class FakeDeleteBuilder {
  filters: Array<{ col: string; val: string }> = [];
  table: string;
  count: number | null;
  error: null = null;
  constructor(table: string, count: number | null) {
    this.table = table;
    this.count = count;
  }
  delete() {
    return this;
  }
  eq(col: string, val: string) {
    this.filters.push({ col, val });
    return this;
  }
}

class FakeSupabaseDelete {
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  async rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    return { data: [{ deleted: true }], error: null };
  }
}

describe("deleteMemoryCascade scoping", () => {
  it("calls scoped delete RPC with workspace and memory ids", async () => {
    const supabase = new FakeSupabaseDelete();
    const result = await deleteMemoryCascade(
      supabase as unknown as { rpc: (name: string, args: Record<string, unknown>) => Promise<unknown> },
      "ws1",
      "mem1",
    );
    expect(result).toBe(true);
    expect(supabase.rpcCalls).toEqual([
      {
        name: "delete_memory_scoped",
        args: {
          p_workspace_id: "ws1",
          p_memory_id: "mem1",
        },
      },
    ]);
  });

  it("removes chunks so they cannot be searched later", async () => {
    // Simulate an in-memory store to represent tables.
    const store = {
      memory_chunks: [{ workspace_id: "ws1", memory_id: "mem1", id: "c1" }],
      memories: [{ workspace_id: "ws1", id: "mem1" }],
    };

    const makeDeleteBuilder = (table: "memory_chunks" | "memories") => {
      return {
        filters: [] as Array<{ col: string; val: string }>,
        error: null as null,
        count: 0,
        totalRemoved: 0,
        eq(col: string, val: string) {
          this.filters.push({ col, val });
          const before = store[table].length;
          store[table] = store[table].filter((row) => (row as any)[col] !== val);
          const removed = before - store[table].length;
          this.totalRemoved += removed;
          this.count = this.totalRemoved;
          return this;
        },
      };
    };

    const supabase = {
      async rpc(name: string, args: Record<string, unknown>) {
        if (name !== "delete_memory_scoped") return { data: null, error: { message: "unsupported rpc" } };
        const workspaceId = String(args.p_workspace_id);
        const memoryId = String(args.p_memory_id);
        const before = store.memories.length;
        store.memory_chunks = store.memory_chunks.filter(
          (row) => !(row.workspace_id === workspaceId && row.memory_id === memoryId),
        );
        store.memories = store.memories.filter(
          (row) => !(row.workspace_id === workspaceId && row.id === memoryId),
        );
        return { data: [{ deleted: store.memories.length < before }], error: null };
      },
    };

    const result = await deleteMemoryCascade(supabase as any, "ws1", "mem1");

    expect(result).toBe(true);
    expect(store.memory_chunks.length).toBe(0);
    expect(store.memories.length).toBe(0);
  });
});
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
