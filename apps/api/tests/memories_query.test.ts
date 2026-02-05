import { describe, expect, it } from "vitest";
import { normalizeMemoryListParams } from "../src/index.js";

const base = "http://localhost/v1/memories";

describe("GET /v1/memories query parsing", () => {
  it("parses URL-encoded metadata JSON", () => {
    const encoded = encodeURIComponent(JSON.stringify({ topic: "ai", level: 2 }));
    const url = new URL(`${base}?metadata=${encoded}`);
    const params = normalizeMemoryListParams(url);
    expect(params.filters.metadata?.topic).toBe("ai");
    expect(params.filters.metadata?.level).toBe(2);
  });

  it("rejects invalid metadata JSON", () => {
    const url = new URL(`${base}?metadata=%7Bbad%7D`);
    expect(() => normalizeMemoryListParams(url)).toThrow();
  });

  it("rejects invalid ISO time", () => {
    const url = new URL(`${base}?start_time=not-a-date`);
    expect(() => normalizeMemoryListParams(url)).toThrow();
  });
});
