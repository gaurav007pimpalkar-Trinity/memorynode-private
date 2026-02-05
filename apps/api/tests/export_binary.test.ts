/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildExportArtifact, makeExportResponse, wantsZipResponse } from "../src/index.js";

const auth = { workspaceId: "ws1", keyHash: "k", plan: "free" } as const;

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

function makeSupabase(memories: MemoryRow[], chunks: ChunkRow[]) {
  return {
    from(table: "memories" | "memory_chunks") {
      const source = table === "memories" ? memories : chunks;
      let rows = source.slice();
      const builder: any = {
        _count: false,
        select: (_cols: string, opts?: { count?: string }) => {
          builder._count = opts?.count === "exact";
          return builder;
        },
        eq: (col: string, val: any) => {
          rows = rows.filter((r) => (r as any)[col] === val);
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          rows.sort((a: any, b: any) => {
            if (a[col] === b[col]) return 0;
            return opts?.ascending ? (a[col] < b[col] ? -1 : 1) : a[col] > b[col] ? -1 : 1;
          });
          return builder;
        },
        then(resolve: any) {
          resolve({ data: rows, error: null, count: builder._count ? rows.length : null });
        },
      };
      return builder;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

function baseMemory(text: string): MemoryRow {
  return {
    id: "m1",
    workspace_id: "ws1",
    user_id: "u1",
    namespace: "default",
    text,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

function baseChunk(mem: MemoryRow): ChunkRow {
  return {
    id: "c1",
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

describe("export limits and binary mode", () => {
  it("enforces MAX_EXPORT_BYTES", async () => {
    const mem = baseMemory("x".repeat(10_000));
    const supabase = makeSupabase([mem], [baseChunk(mem)]);
    await expect(buildExportArtifact(auth, supabase as any, 500)).rejects.toThrowError(/exceeds/);
  });

  it("returns deterministic zip when requested", async () => {
    const mem = baseMemory("hello");
    const supabase = makeSupabase([mem], [baseChunk(mem)]);
    const outcome = await buildExportArtifact(auth, supabase as any, 1_000_000);
    const req = new Request("http://localhost/v1/export", {
      headers: { accept: "application/zip" },
      method: "POST",
    });
    const wantsZip = wantsZipResponse(req);
    expect(wantsZip).toBe(true);
    const resp = makeExportResponse(outcome, wantsZip, auth, {});
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/zip");
    expect(resp.headers.get("content-disposition")).toMatch(/memorynode-export-ws1-\d{4}-\d{2}-\d{2}\.zip/);
    const buf = new Uint8Array(await resp.arrayBuffer());
    expect(buf.length).toBe(outcome.bytes);

    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    const hashHex = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hashHex).toBe(outcome.sha256);

    const zip = await JSZip.loadAsync(buf);
    const manifestStr = await zip.file("manifest.json")!.async("string");
    const manifest = JSON.parse(manifestStr);
    expect(manifest.workspace_id).toBe("ws1");
    expect(manifest.counts.memories).toBe(1);
    expect(manifest.files.some((f: any) => f.name === "memories.ndjson")).toBe(true);
  });
});
