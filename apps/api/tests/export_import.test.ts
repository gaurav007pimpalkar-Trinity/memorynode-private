/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { buildExportArtifact, importArtifact } from "../src/index.js";

type MemoryRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  namespace: string;
  text: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type ChunkRow = {
  id: string;
  workspace_id: string;
  memory_id: string;
  user_id: string;
  namespace: string;
  chunk_index: number;
  chunk_text: string;
  embedding: string;
  created_at: string;
};

const auth = { workspaceId: "ws1", keyHash: "k", plan: "free" } as const;

function baseMemory(id: string, text = "hello", created = "2026-01-01T00:00:00Z"): MemoryRow {
  return {
    id,
    workspace_id: "ws1",
    user_id: "u1",
    namespace: "default",
    text,
    metadata: {},
    created_at: created,
  };
}

function baseChunk(mem: MemoryRow, chunkId?: string): ChunkRow {
  return {
    id: chunkId ?? `c-${mem.id}`,
    workspace_id: mem.workspace_id,
    memory_id: mem.id,
    user_id: mem.user_id,
    namespace: mem.namespace,
    chunk_index: 0,
    chunk_text: mem.text,
    embedding: "[0,1]",
    created_at: mem.created_at,
  };
}

function makeStore(memories: MemoryRow[] = [baseMemory("m1", "hello")]) {
  return {
    memories: memories.map((m) => ({ ...m })),
    memory_chunks: memories.map((m) => baseChunk(m)),
  };
}

function makeSupabase(store: { memories: MemoryRow[]; memory_chunks: ChunkRow[] }) {
  return {
    from(table: "memories" | "memory_chunks") {
      const builder: any = {
        _filters: [] as Array<{ type: "eq" | "in"; col: string; val: any }>,
        _count: false,
        select: (_cols: string, opts?: { count?: string }) => {
          builder._count = opts?.count === "exact";
          return builder;
        },
        eq: (col: string, val: any) => {
          builder._filters.push({ type: "eq", col, val });
          return builder;
        },
        in: (col: string, vals: any[]) => {
          builder._filters.push({ type: "in", col, val: vals });
          return builder;
        },
        order: () => builder,
        range: () => builder,
        delete: () => {
          const runDelete = () => {
            const matches = (row: any) =>
              builder._filters.every((f: any) =>
                f.type === "eq" ? row[f.col] === f.val : (f.val as any[]).includes(row[f.col]),
              );
            const remaining = store[table].filter((row: any) => !matches(row));
            store[table] = remaining;
            return { error: null };
          };
          return {
            eq: (col: string, val: any) => {
              builder._filters.push({ type: "eq", col, val });
              return {
                in: (col2: string, vals: any[]) => {
                  builder._filters.push({ type: "in", col: col2, val: vals });
                  return runDelete();
                },
                then(resolve: any) {
                  return resolve(runDelete());
                },
              };
            },
            in: (col: string, vals: any[]) => {
              builder._filters.push({ type: "in", col, val: vals });
              return runDelete();
            },
            then(resolve: any) {
              return resolve(runDelete());
            },
          };
        },
        upsert: async (rows: any[]) => {
          for (const row of rows) {
            const idx = store[table].findIndex((r: any) => r.id === row.id);
            if (idx >= 0) {
              store[table][idx] = { ...store[table][idx], ...row };
            } else {
              store[table].push(row);
            }
          }
          return { data: rows, error: null };
        },
        insert: async (rows: any[], opts?: { ignoreDuplicates?: boolean }) => {
          for (const row of rows) {
            const idx = store[table].findIndex((r: any) => r.id === row.id);
            if (idx >= 0) {
              if (opts?.ignoreDuplicates) continue;
              store[table][idx] = row;
            } else {
              store[table].push(row);
            }
          }
          return { data: rows, error: null };
        },
        then(resolve: any) {
          const matches = (row: any) =>
            builder._filters.every((f: any) =>
              f.type === "eq" ? row[f.col] === f.val : (f.val as any[]).includes(row[f.col]),
            );
          const data = builder._filters.length ? store[table].filter(matches) : store[table].slice();
          const count = builder._count ? data.length : null;
          resolve({ data, error: null, count });
        },
      };
      return builder;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

async function exportFrom(store: ReturnType<typeof makeStore>) {
  return buildExportArtifact(auth, makeSupabase(store) as any);
}

describe("export/import roundtrip", () => {
  it("deterministic export and successful import", async () => {
    const store = makeStore();
    const exp1 = await exportFrom(store);
    const exp2 = await exportFrom(store);
    expect(exp1.artifact_base64).toBe(exp2.artifact_base64);

    store.memories.length = 0;
    store.memory_chunks.length = 0;
    const outcome = await importArtifact(auth, makeSupabase(store) as any, exp1.artifact_base64, 1_000_000);
    expect(outcome.imported_memories).toBe(1);
    expect(outcome.imported_chunks).toBe(1);
    expect(store.memories.length).toBe(1);
  });

  it("rejects workspace mismatch", async () => {
    const store = makeStore();
    const exp = await exportFrom(store);
    await expect(
      importArtifact({ ...auth, workspaceId: "other" } as any, makeSupabase(store) as any, exp.artifact_base64, 1_000_000),
    ).rejects.toThrow();
  });

  it("default upsert is non-destructive and idempotent", async () => {
    const artifactStore = makeStore([baseMemory("m1", "new-text")]);
    const artifact = await exportFrom(artifactStore);

    const targetStore = makeStore([baseMemory("m1", "old-text"), baseMemory("m2", "keep-me")]);
    targetStore.memory_chunks[0].id = "old-chunk";
    const supabase = makeSupabase(targetStore);

    const first = await importArtifact(auth, supabase as any, artifact.artifact_base64, 1_000_000);
    expect(first.imported_memories).toBe(1);
    expect(targetStore.memories.find((m) => m.id === "m1")?.text).toBe("new-text");
    expect(targetStore.memories.find((m) => m.id === "m2")).toBeTruthy();

    const second = await importArtifact(auth, supabase as any, artifact.artifact_base64, 1_000_000);
    expect(second.imported_memories).toBe(1);
    expect(new Set(targetStore.memories.map((m) => m.id))).toEqual(new Set(["m1", "m2"]));
    expect(new Set(targetStore.memory_chunks.map((c) => c.id)).size).toBe(targetStore.memory_chunks.length);
  });

  it("skip_existing inserts only new ids and leaves existing untouched", async () => {
    const artifactStore = makeStore([baseMemory("m1", "incoming"), baseMemory("m2", "newbie")]);
    const artifact = await exportFrom(artifactStore);

    const targetStore = makeStore([baseMemory("m1", "current")]);
    targetStore.memory_chunks[0].id = "chunk-existing";
    const supabase = makeSupabase(targetStore);

    const outcome = await importArtifact(auth, supabase as any, artifact.artifact_base64, 1_000_000, "skip_existing");
    expect(outcome.imported_memories).toBe(1);
    expect(targetStore.memories.find((m) => m.id === "m1")?.text).toBe("current");
    expect(targetStore.memories.find((m) => m.id === "m2")?.text).toBe("newbie");
    expect(targetStore.memory_chunks.find((c) => c.id === "chunk-existing")).toBeTruthy();
  });

  it("error_on_conflict rejects when ids already exist", async () => {
    const artifact = await exportFrom(makeStore([baseMemory("m1", "incoming")]));
    const targetStore = makeStore([baseMemory("m1", "present")]);
    const supabase = makeSupabase(targetStore);

    await expect(
      importArtifact(auth, supabase as any, artifact.artifact_base64, 1_000_000, "error_on_conflict"),
    ).rejects.toThrow();
    expect(targetStore.memories.find((m) => m.id === "m1")?.text).toBe("present");
  });

  it("replace_ids refreshes only provided ids", async () => {
    const artifactStore = makeStore([baseMemory("m1", "replaced"), baseMemory("m2", "stay")]);
    artifactStore.memory_chunks[0].id = "new-chunk";
    const artifact = await exportFrom(artifactStore);

    const targetStore = makeStore([baseMemory("m1", "old"), baseMemory("m2", "keep")]);
    targetStore.memory_chunks[0].id = "old-chunk";
    const supabase = makeSupabase(targetStore);

    const outcome = await importArtifact(auth, supabase as any, artifact.artifact_base64, 1_000_000, "replace_ids");
    expect(outcome.imported_memories).toBe(2);
    expect(targetStore.memories.find((m) => m.id === "m1")?.text).toBe("replaced");
    expect(targetStore.memories.find((m) => m.id === "m2")?.text).toBe("stay");
    expect(targetStore.memory_chunks.find((c) => c.id === "old-chunk")).toBeUndefined();
    expect(targetStore.memory_chunks.find((c) => c.id === "new-chunk")).toBeTruthy();
  });

  it("replace_all clears workspace before import", async () => {
    const artifact = await exportFrom(makeStore([baseMemory("m1", "fresh")]));
    const targetStore = makeStore([baseMemory("m1", "old"), baseMemory("m2", "delete-me")]);
    const supabase = makeSupabase(targetStore);

    const outcome = await importArtifact(auth, supabase as any, artifact.artifact_base64, 1_000_000, "replace_all");
    expect(outcome.imported_memories).toBe(1);
    expect(targetStore.memories.map((m) => m.id)).toEqual(["m1"]);
    expect(targetStore.memory_chunks.map((c) => c.memory_id)).toEqual(["m1"]);
  });
});
