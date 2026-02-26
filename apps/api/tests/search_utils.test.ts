import { describe, expect, it } from "vitest";
import {
  chunkText,
  dedupeFusionResults,
  finalizeResults,
  normalizeSearchPayload,
} from "../src/index.js";
import { DEFAULT_TOPK, MAX_TOPK } from "../src/limits.js";

describe("normalizeSearchPayload", () => {
  it("applies defaults for legacy payloads", () => {
    const norm = normalizeSearchPayload({ user_id: "u1", query: "hello world" });
    expect(norm.namespace).toBe("default");
    expect(norm.top_k).toBe(DEFAULT_TOPK);
    expect(norm.page).toBe(1);
    expect(norm.page_size).toBe(DEFAULT_TOPK);
    expect(norm.filters.metadata).toBeUndefined();
  });

  it("clamps values and normalizes filters", () => {
    const norm = normalizeSearchPayload({
      user_id: "u1",
      query: "hi",
      top_k: 99,
      page: 2,
      page_size: 5,
      filters: {
        metadata: { topic: "ai" },
        start_time: "2024-01-01T00:00:00Z",
        end_time: "2024-02-01T00:00:00Z",
      },
    });
    expect(norm.top_k).toBe(MAX_TOPK);
    expect(norm.page).toBe(2);
    expect(norm.page_size).toBe(5);
    expect(norm.filters.metadata?.topic).toBe("ai");
    expect(norm.filters.start_time?.startsWith("2024-01-01")).toBe(true);
    expect(norm.filters.end_time?.startsWith("2024-02-01")).toBe(true);
  });

  it("rejects inverted time windows", () => {
    expect(() =>
      normalizeSearchPayload({
        user_id: "u1",
        query: "q",
        filters: { start_time: "2024-03-01T00:00:00Z", end_time: "2024-02-01T00:00:00Z" },
      }),
    ).toThrow();
  });

  it("normalizes search_mode and min_score", () => {
    const norm = normalizeSearchPayload({
      user_id: "u1",
      query: "test",
      search_mode: "keyword",
      min_score: 0.5,
    });
    expect(norm.search_mode).toBe("keyword");
    expect(norm.min_score).toBe(0.5);
  });

  it("defaults search_mode to hybrid", () => {
    const norm = normalizeSearchPayload({ user_id: "u1", query: "test" });
    expect(norm.search_mode).toBe("hybrid");
    expect(norm.min_score).toBeUndefined();
  });

  it("normalizes memory_type filter as array", () => {
    const norm = normalizeSearchPayload({
      user_id: "u1",
      query: "test",
      filters: { memory_type: "fact" },
    });
    expect(norm.filters.memory_types).toEqual(["fact"]);
    expect(norm.filters.filter_mode).toBe("and");
  });

  it("passes through memory_type array and filter_mode", () => {
    const norm = normalizeSearchPayload({
      user_id: "u1",
      query: "test",
      filters: { memory_type: ["fact", "preference"], filter_mode: "or" },
    });
    expect(norm.filters.memory_types).toEqual(["fact", "preference"]);
    expect(norm.filters.filter_mode).toBe("or");
  });
});

describe("chunkText paragraph aware", () => {
  it("splits by paragraphs and respects chunk size", () => {
    const text = [
      "First paragraph line one.",
      "",
      "Second paragraph short.",
      "",
      "Third paragraph is very long and should be broken into multiple overlapping chunks because it exceeds the limit.".repeat(
        5,
      ),
    ].join("\n");

    const chunks = chunkText(text, 40, 8);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
    expect(chunks.some((c) => c.includes("Second paragraph"))).toBe(true);
    const longChunks = chunks.filter((c) => c.includes("Third paragraph"));
    expect(longChunks.length).toBeGreaterThan(1);
  });

  it("returns empty array for empty input", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("ignores excessive blank lines", () => {
    const text = "\n\n\nPara one\n\n\n\nPara two\n\n";
    const chunks = chunkText(text, 50, 10);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]).toContain("Para one");
    expect(chunks.join(" ")).toContain("Para two");
  });

  it("handles extremely long single paragraph with overlap", () => {
    const para = "A".repeat(1200);
    const chunks = chunkText(para, 300, 50);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });

  it("preserves unicode and emoji and remains deterministic", () => {
    const text = "🚀 Launch\n\n✨ Shine bright\n\n🚀 Launch";
    const first = chunkText(text, 50, 10);
    const second = chunkText(text, 50, 10);
    expect(first).toEqual(second);
    expect(first.some((c) => c.includes("🚀"))).toBe(true);
  });

  it("never emits empty chunks", () => {
    const text = "Line1\n\n\n\n";
    const chunks = chunkText(text, 10, 2);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });
});

describe("dedupeFusionResults", () => {
  it("drops duplicate text across results", () => {
    const deduped = dedupeFusionResults([
      { chunk_id: "c1", memory_id: "m1", chunk_index: 0, text: "Hello World", score: 1 },
      { chunk_id: "c2", memory_id: "m2", chunk_index: 0, text: "hello   world ", score: 0.9 },
      { chunk_id: "c3", memory_id: "m3", chunk_index: 1, text: "Different", score: 0.8 },
    ]);
    expect(deduped.length).toBe(2);
    expect(deduped[0].chunk_id).toBe("c1");
    expect(deduped[1].chunk_id).toBe("c3");
  });

  it("dedup happens before pagination (no duplicates spill to next page)", () => {
    const fused = [
      { chunk_id: "c1", memory_id: "m1", chunk_index: 0, text: "Same text", score: 1.0 },
      { chunk_id: "c2", memory_id: "m2", chunk_index: 0, text: "Same   text", score: 0.99 },
      { chunk_id: "c3", memory_id: "m3", chunk_index: 0, text: "Unique", score: 0.5 },
    ];
    const { results: page1, has_more: page1HasMore, total } = finalizeResults(fused, 1, 1);
    expect(page1.length).toBe(1);
    expect(page1[0].chunk_id).toBe("c1");
    expect(page1HasMore).toBe(true);

    const { results: page2, has_more: page2HasMore } = finalizeResults(fused, 2, 1);
    expect(page2.length).toBe(1);
    expect(page2[0].chunk_id).toBe("c3");
    expect(page2HasMore).toBe(false);
    expect(total).toBe(2);
  });
});
