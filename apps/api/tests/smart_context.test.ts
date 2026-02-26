import { describe, expect, it } from "vitest";
import {
  assembleSmartContext,
  wordSet,
  jaccardSimilarity,
  isSubstringOf,
  JACCARD_DEDUP_THRESHOLD,
  type SearchResultItem,
} from "../src/handlers/context.js";

describe("wordSet", () => {
  it("lowercases and strips punctuation", () => {
    const ws = wordSet("Hello, World! Foo-bar.");
    expect(ws.has("hello")).toBe(true);
    expect(ws.has("world")).toBe(true);
    expect(ws.has("foobar")).toBe(true);
    expect(ws.has("Hello")).toBe(false);
  });

  it("returns empty set for empty string", () => {
    expect(wordSet("").size).toBe(0);
    expect(wordSet("   ").size).toBe(0);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    const s = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns 1 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it("computes correct partial overlap", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });
});

describe("isSubstringOf", () => {
  it("detects containment", () => {
    expect(isSubstringOf("hello", "say hello world")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isSubstringOf("HELLO", "say hello world")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(isSubstringOf("  hello  ", "say hello world")).toBe(true);
  });

  it("returns false for non-containment", () => {
    expect(isSubstringOf("goodbye", "say hello world")).toBe(false);
  });
});

describe("assembleSmartContext", () => {
  it("returns empty for empty input", () => {
    expect(assembleSmartContext([])).toEqual([]);
  });

  it("merges adjacent chunks from the same memory", () => {
    const items: SearchResultItem[] = [
      { chunk_id: "c1", memory_id: "m1", chunk_index: 0, text: "Part A", score: 1 },
      { chunk_id: "c2", memory_id: "m1", chunk_index: 1, text: "Part B", score: 0.9 },
      { chunk_id: "c3", memory_id: "m1", chunk_index: 2, text: "Part C", score: 0.8 },
    ];
    const blocks = assembleSmartContext(items);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("Part A\nPart B\nPart C");
    expect(blocks[0].chunk_ids).toEqual(["c1", "c2", "c3"]);
    expect(blocks[0].chunk_indices).toEqual([0, 1, 2]);
  });

  it("splits non-adjacent chunks into separate blocks", () => {
    const items: SearchResultItem[] = [
      { chunk_id: "c1", memory_id: "m1", chunk_index: 0, text: "Part A", score: 1 },
      { chunk_id: "c2", memory_id: "m1", chunk_index: 3, text: "Part D", score: 0.9 },
    ];
    const blocks = assembleSmartContext(items);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe("Part A");
    expect(blocks[1].text).toBe("Part D");
  });

  it("keeps different memories as separate blocks", () => {
    const items: SearchResultItem[] = [
      { chunk_id: "c1", memory_id: "m1", chunk_index: 0, text: "Memory one", score: 1 },
      { chunk_id: "c2", memory_id: "m2", chunk_index: 0, text: "Memory two", score: 0.9 },
    ];
    const blocks = assembleSmartContext(items);
    expect(blocks).toHaveLength(2);
  });

  it("deduplicates blocks where one is a substring of another", () => {
    const items: SearchResultItem[] = [
      { chunk_id: "c1", memory_id: "m1", chunk_index: 0, text: "The quick brown fox jumps over the lazy dog", score: 1 },
      { chunk_id: "c2", memory_id: "m2", chunk_index: 0, text: "quick brown fox", score: 0.8 },
    ];
    const blocks = assembleSmartContext(items);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("quick brown fox jumps");
  });

  it("deduplicates blocks with high Jaccard similarity", () => {
    const items: SearchResultItem[] = [
      { chunk_id: "c1", memory_id: "m1", chunk_index: 0, text: "the quick brown fox jumps over lazy dog", score: 1 },
      { chunk_id: "c2", memory_id: "m2", chunk_index: 0, text: "the quick brown fox jumps over the lazy dog", score: 0.9 },
    ];
    const blocks = assembleSmartContext(items);
    expect(blocks).toHaveLength(1);
  });

  it("keeps blocks with low similarity as separate", () => {
    const items: SearchResultItem[] = [
      { chunk_id: "c1", memory_id: "m1", chunk_index: 0, text: "The weather is sunny today", score: 1 },
      { chunk_id: "c2", memory_id: "m2", chunk_index: 0, text: "Quantum computing uses qubits for processing", score: 0.9 },
    ];
    const blocks = assembleSmartContext(items);
    expect(blocks).toHaveLength(2);
  });

  it("preserves original score-based ordering", () => {
    const items: SearchResultItem[] = [
      { chunk_id: "c1", memory_id: "m1", chunk_index: 0, text: "High score result", score: 1.0 },
      { chunk_id: "c2", memory_id: "m2", chunk_index: 0, text: "Low score result", score: 0.5 },
    ];
    const blocks = assembleSmartContext(items);
    expect(blocks[0].text).toBe("High score result");
    expect(blocks[1].text).toBe("Low score result");
  });

  it("handles empty text blocks", () => {
    const items: SearchResultItem[] = [
      { chunk_id: "c1", memory_id: "m1", chunk_index: 0, text: "", score: 1 },
      { chunk_id: "c2", memory_id: "m2", chunk_index: 0, text: "Real content", score: 0.9 },
    ];
    const blocks = assembleSmartContext(items);
    expect(blocks).toHaveLength(2);
  });

  it("exports JACCARD_DEDUP_THRESHOLD as 0.75", () => {
    expect(JACCARD_DEDUP_THRESHOLD).toBe(0.75);
  });
});
