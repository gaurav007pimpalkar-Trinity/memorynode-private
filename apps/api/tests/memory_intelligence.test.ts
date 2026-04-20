import { describe, expect, it } from "vitest";
import {
  computeIntelligenceScore,
  deterministicExtractFallback,
  normalizeExtractedCandidates,
  normalizeTextForMemoryKey,
  semanticFingerprintFromText,
} from "../src/memories/intelligence.js";

describe("memory intelligence", () => {
  it("normalizes text key and semantic fingerprint deterministically", () => {
    expect(normalizeTextForMemoryKey("  Hello   WORLD ")).toBe("hello world");
    expect(semanticFingerprintFromText("Hello world, this is a memory!")).toBe(
      "v1:hello|world|this|memory",
    );
  });

  it("computes high priority scores for explicit corrections", () => {
    const score = computeIntelligenceScore({
      text: "Correction: user is not vegetarian anymore.",
      memoryType: "correction",
      extractionConfidence: 0.9,
      sourceWeight: 1.25,
      noveltyScore: 0.8,
    });
    expect(score.priorityScore).toBeGreaterThan(0.7);
    expect(["hot", "critical"]).toContain(score.priorityTier);
  });

  it("falls back to deterministic extraction when needed", () => {
    const extracted = deterministicExtractFallback(
      "I love Thai food. I am allergic to peanuts. Yesterday I visited Bangkok.",
    );
    expect(extracted.length).toBeGreaterThan(0);
    expect(extracted.some((x) => x.memory_type === "event")).toBe(true);
    expect(extracted.some((x) => ["fact", "preference"].includes(x.memory_type))).toBe(true);
  });

  it("normalizes extracted candidates into valid schema", () => {
    const normalized = normalizeExtractedCandidates([
      { text: "User likes tea", memory_type: "preference", confidence: 0.91 },
      { text: "tiny", memory_type: "fact" },
      { text: "User visited Pune last week" },
    ]);
    expect(normalized).toHaveLength(2);
    expect(normalized[0].memory_type).toBe("preference");
    expect(normalized[0].confidence).toBe(0.91);
    expect(["event", "fact", "preference"]).toContain(normalized[1].memory_type);
  });
});
