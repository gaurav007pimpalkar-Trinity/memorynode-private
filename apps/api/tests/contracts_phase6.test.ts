import { describe, expect, it } from "vitest";
import { SearchPayloadSchema, MemoryInsertSchema, MEMORY_TYPES, SEARCH_MODES } from "../src/contracts/index.js";

describe("SearchPayloadSchema Phase 6 fields", () => {
  it("accepts search_mode values", () => {
    for (const mode of SEARCH_MODES) {
      const result = SearchPayloadSchema.safeParse({
        user_id: "u1",
        query: "test",
        search_mode: mode,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid search_mode", () => {
    const result = SearchPayloadSchema.safeParse({
      user_id: "u1",
      query: "test",
      search_mode: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts min_score in valid range", () => {
    const result = SearchPayloadSchema.safeParse({
      user_id: "u1",
      query: "test",
      min_score: 0.5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects min_score out of range", () => {
    expect(SearchPayloadSchema.safeParse({ user_id: "u1", query: "q", min_score: -0.1 }).success).toBe(false);
    expect(SearchPayloadSchema.safeParse({ user_id: "u1", query: "q", min_score: 1.1 }).success).toBe(false);
  });

  it("accepts memory_type filter as single value", () => {
    const result = SearchPayloadSchema.safeParse({
      user_id: "u1",
      query: "test",
      filters: { memory_type: "fact" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts memory_type filter as array", () => {
    const result = SearchPayloadSchema.safeParse({
      user_id: "u1",
      query: "test",
      filters: { memory_type: ["fact", "preference"] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid memory_type filter", () => {
    const result = SearchPayloadSchema.safeParse({
      user_id: "u1",
      query: "test",
      filters: { memory_type: "invalid_type" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts filter_mode and/or", () => {
    for (const mode of ["and", "or"]) {
      const result = SearchPayloadSchema.safeParse({
        user_id: "u1",
        query: "test",
        filters: { filter_mode: mode },
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("MemoryInsertSchema Phase 6 fields", () => {
  it("accepts memory_type values", () => {
    for (const mt of MEMORY_TYPES) {
      const result = MemoryInsertSchema.safeParse({
        user_id: "u1",
        text: "some text",
        memory_type: mt,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid memory_type", () => {
    const result = MemoryInsertSchema.safeParse({
      user_id: "u1",
      text: "some text",
      memory_type: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts extract boolean", () => {
    const result = MemoryInsertSchema.safeParse({
      user_id: "u1",
      text: "some text",
      extract: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts payload without Phase 6 fields (backward compatible)", () => {
    const result = MemoryInsertSchema.safeParse({
      user_id: "u1",
      text: "some text",
    });
    expect(result.success).toBe(true);
  });
});
