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
  logs: Record<string, FakeDeleteBuilder> = {};
  from(table: string) {
    const builder = new FakeDeleteBuilder(table, table === "memories" ? 1 : null);
    this.logs[table] = builder;
    return builder;
  }
}

describe("deleteMemoryCascade scoping", () => {
  it("applies workspace and memory filters to chunks and memories", async () => {
    const supabase = new FakeSupabaseDelete();
    const result = await deleteMemoryCascade(
      supabase as unknown as { from: (table: string) => FakeDeleteBuilder },
      "ws1",
      "mem1",
    );
    expect(result).toBe(true);
    const chunkFilters = supabase.logs["memory_chunks"].filters;
    const memFilters = supabase.logs["memories"].filters;
    expect(chunkFilters).toEqual([
      { col: "workspace_id", val: "ws1" },
      { col: "memory_id", val: "mem1" },
    ]);
    expect(memFilters).toEqual([
      { col: "workspace_id", val: "ws1" },
      { col: "id", val: "mem1" },
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
      from(table: "memory_chunks" | "memories") {
        return {
          delete: (_opts?: { count?: string }) => {
            const builder = makeDeleteBuilder(table);
            return builder;
          },
        };
      },
    };

    const result = await deleteMemoryCascade(supabase as any, "ws1", "mem1");

    expect(result).toBe(true);
    expect(store.memory_chunks.length).toBe(0);
    expect(store.memories.length).toBe(0);
  });
});
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
