import { describe, expect, it } from "vitest";
import { applyCostAwareRetrievalCap, budgetContextBlocks } from "../src/search/contextBudget.js";

describe("context budgeting", () => {
  it("packs blocks under token budget by value density", () => {
    const blocks = [
      { text: "short high value", chunk_ids: ["a"], memory_ids: ["m1"], chunk_indices: [0] },
      { text: "x".repeat(600), chunk_ids: ["b"], memory_ids: ["m2"], chunk_indices: [1] },
      { text: "medium value block text", chunk_ids: ["c"], memory_ids: ["m3"], chunk_indices: [2] },
    ];
    const selected = budgetContextBlocks(blocks, { maxTokens: 60, fallbackScore: 0.8 });
    const totalTokens = selected.reduce((acc, row) => acc + row.estimated_tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(60);
    expect(selected.length).toBeGreaterThan(0);
  });

  it("reduces retrieval caps under high budget pressure", () => {
    const capped = applyCostAwareRetrievalCap({
      requestedTopK: 20,
      requestedPageSize: 30,
      budgetPressure: 0.9,
    });
    expect(capped.topK).toBeLessThan(20);
    expect(capped.pageSize).toBeLessThan(30);
  });
});
