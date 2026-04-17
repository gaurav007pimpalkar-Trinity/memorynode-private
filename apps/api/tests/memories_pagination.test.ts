/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, expect, it } from "vitest";
import { performListMemories } from "../src/index.js";

type MemoryRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  namespace: string;
  text: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

function buildStore(count: number): MemoryRow[] {
  const rows: MemoryRow[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: `mem-${i.toString().padStart(3, "0")}`,
      workspace_id: "ws1",
      user_id: i % 2 === 0 ? "userA" : "userB",
      namespace: i % 3 === 0 ? "nsA" : "default",
      text: `text-${i}`,
      metadata: i % 4 === 0 ? { topic: "ai" } : {},
      created_at: new Date(Date.now() - i * 1000).toISOString(), // descending by i
    });
  }
  return rows;
}

function makeSupabase(memories: MemoryRow[]) {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== "list_memories_scoped") {
        return { data: null, error: { message: "unsupported rpc" } };
      }
      const page = Number(args.p_page ?? 1);
      const pageSize = Number(args.p_page_size ?? 20);
      let data = memories
        .filter((r) => r.workspace_id === args.p_workspace_id)
        .filter((r) => (args.p_namespace ? r.namespace === args.p_namespace : true))
        .filter((r) => (args.p_user_id ? r.user_id === args.p_user_id : true))
        .filter((r) => (args.p_memory_type ? (r as { memory_type?: string }).memory_type === args.p_memory_type : true))
        .filter((r) => {
          if (!args.p_metadata) return true;
          const meta = r.metadata ?? {};
          return Object.entries(args.p_metadata as Record<string, unknown>).every(([k, v]) => meta[k] === v);
        });
      if (args.p_start_time) data = data.filter((r) => r.created_at >= String(args.p_start_time));
      if (args.p_end_time) data = data.filter((r) => r.created_at <= String(args.p_end_time));
      data = data.sort((a, b) => {
        if (a.created_at === b.created_at) return b.id.localeCompare(a.id);
        return b.created_at.localeCompare(a.created_at);
      });
      const total = data.length;
      const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(1, pageSize));
      const pageRows = data.slice(offset, offset + pageSize + 1).map((row) => ({ ...row, total_count: total }));
      return { data: pageRows, error: null };
    },
    from(table: "memories") {
      let data = memories.slice();
      const orderBy: Array<{ col: string; ascending: boolean }> = [];
      let range: { from: number; to: number } | null = null;
      const builder: any = {
        select: (_cols: string, opts?: { count?: string }) => {
          builder._countRequested = opts?.count === "exact";
          return builder;
        },
        eq: (col: string, val: string) => {
          data = data.filter((r) => (r as any)[col] === val);
          return builder;
        },
        is: (col: string, val: null) => {
          data = data.filter((r) => (r as any)[col] == null);
          return builder;
        },
        contains: (col: string, val: Record<string, unknown>) => {
          data = data.filter((r) => {
            const meta = (r as any)[col] ?? {};
            return Object.entries(val).every(([k, v]) => meta[k] === v);
          });
          return builder;
        },
        gte: (col: string, val: string) => {
          data = data.filter((r) => (r as any)[col] >= val);
          return builder;
        },
        lte: (col: string, val: string) => {
          data = data.filter((r) => (r as any)[col] <= val);
          return builder;
        },
        order: (col: string, opts: { ascending: boolean }) => {
          orderBy.push({ col, ascending: opts.ascending });
          return builder;
        },
        range: (from: number, to: number) => {
          range = { from, to };
          return builder;
        },
        async then(resolve: any) {
          let working = data.slice();
          if (orderBy.length > 0) {
            working = working.sort((a, b) => {
              for (const ord of orderBy) {
                const dir = ord.ascending ? 1 : -1;
                if ((a as any)[ord.col] < (b as any)[ord.col]) return -1 * dir;
                if ((a as any)[ord.col] > (b as any)[ord.col]) return 1 * dir;
              }
              // stable tie-breaker by id desc for determinism
              return b.id.localeCompare(a.id);
            });
          }
          const count = builder._countRequested ? working.length : null;
          if (range) {
            working = working.slice(range.from, range.to + 1);
          }
          resolve({ data: working, error: null, count });
        },
      };
      return builder;
    },
  };
}

describe("performListMemories pagination", () => {
  const auth = { workspaceId: "ws1", keyHash: "", plan: "free" } as const;

  it("paginates deterministically without duplicates", async () => {
    const store = buildStore(11);
    const supabase = makeSupabase(store);
    const pageSize = 5;

    const page1 = await performListMemories(
      auth,
      { page: 1, page_size: pageSize, namespace: undefined, user_id: undefined, filters: {} },
      supabase as any,
    );
    const page2 = await performListMemories(
      auth,
      { page: 2, page_size: pageSize, namespace: undefined, user_id: undefined, filters: {} },
      supabase as any,
    );

    // Ordering: created_at desc then id desc
    const combined = [...page1.results, ...page2.results];
    const sorted = [...combined].sort((a, b) => {
      if (a.created_at === b.created_at) return b.id.localeCompare(a.id);
      return b.created_at.localeCompare(a.created_at);
    });
    expect(combined).toEqual(sorted);

    // No duplicates across pages
    const ids1 = new Set(page1.results.map((r) => r.id));
    const ids2 = new Set(page2.results.map((r) => r.id));
    ids1.forEach((id) => expect(ids2.has(id)).toBe(false));

    expect(page1.has_more).toBe(true);
    expect(page2.has_more).toBe(true); // 11 items => page2 still has item left
    expect(page1.total).toBeGreaterThanOrEqual(page1.results.length);
    expect(page2.total).toBeGreaterThanOrEqual(page2.results.length);
    expect(page2.total).toBeGreaterThanOrEqual(page1.total);
  });

  it("respects filters for total and has_more", async () => {
    const store = buildStore(12);
    const supabase = makeSupabase(store);
    const pageSize = 3;

    const filtered = await performListMemories(
      auth,
      {
        page: 1,
        page_size: pageSize,
        namespace: "nsA",
        user_id: undefined,
        filters: { metadata: { topic: "ai" }, start_time: undefined, end_time: undefined },
      },
      supabase as any,
    );

    const expectedCount = store.filter((r) => r.namespace === "nsA" && (r.metadata as any).topic === "ai").length;
    expect(filtered.total).toBe(expectedCount);
    expect(filtered.results.every((r) => r.namespace === "nsA")).toBe(true);
    expect(filtered.results.every((r) => (r.metadata as any).topic === "ai")).toBe(true);
    const expectedHasMore = expectedCount > pageSize;
    expect(filtered.has_more).toBe(expectedHasMore);
  });

  it("fails closed when scoped RPC fails", async () => {
    const supabase = {
      async rpc() {
        return { data: null, error: { message: "rpc unavailable" } };
      },
    };
    await expect(
      performListMemories(
        auth,
        { page: 1, page_size: 5, namespace: undefined, user_id: undefined, filters: {} },
        supabase as any,
      ),
    ).rejects.toMatchObject({ code: "DB_ERROR" });
  });
});
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
