import { describe, expect, it } from "vitest";
import { mapSearchResultsToRows, type SearchApiResult } from "../src/memorySearch";

describe("memory search contract mapping", () => {
  it("maps chunk-level API results to UI rows without fabricating memory fields", () => {
    const apiResults: SearchApiResult[] = [
      {
        chunk_id: "11111111-1111-1111-1111-111111111111",
        memory_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        chunk_index: 2,
        text: "User prefers dark mode",
        score: 0.92,
      },
    ];

    const rows = mapSearchResultsToRows(apiResults);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      key: "11111111-1111-1111-1111-111111111111:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:2",
      memoryId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      chunkId: "11111111-1111-1111-1111-111111111111",
      chunkIndex: 2,
      text: "User prefers dark mode",
      score: 0.92,
    });
  });
});
