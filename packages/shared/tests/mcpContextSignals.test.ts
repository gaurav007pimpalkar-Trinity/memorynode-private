import { describe, expect, it } from "vitest";
import { deriveContextSignals } from "../src/mcpContextSignals.js";

describe("deriveContextSignals", () => {
  it("returns weak when recall is empty", () => {
    const out = deriveContextSignals({ topScore: 0, secondScore: 0, sourceCount: 0, truncated: false });
    expect(out.recall_strength).toBe("weak");
    expect(out.confidence).toBe(0);
    expect(out.integrity_score).toBe(0);
  });

  it("returns strong on high confidence and score gap", () => {
    const out = deriveContextSignals({
      topScore: 0.08,
      secondScore: -0.05,
      sourceCount: 3,
      totalSourceCount: 3,
      memoryTexts: ["user likes dark mode", "user prefers slate theme", "user uses low light setup"],
      truncated: false,
    });
    expect(out.recall_strength === "strong" || out.recall_strength === "medium").toBe(true);
    expect(out.confidence).toBeGreaterThan(0.6);
  });

  it("propagates truncation flag", () => {
    const out = deriveContextSignals({ topScore: 0.04, secondScore: 0.02, sourceCount: 2, truncated: true });
    expect(out.truncated).toBe(true);
    expect(out.recall_strength).toBe("medium");
  });

  it("downgrades confidence when integrity is low", () => {
    const out = deriveContextSignals({
      topScore: 0.08,
      secondScore: 0.05,
      sourceCount: 1,
      totalSourceCount: 5,
      memoryTexts: [
        "same repeated statement about user theme",
        "same repeated statement about user theme",
        "same repeated statement about user theme",
      ],
      truncated: false,
    });
    expect(out.integrity_score).toBeLessThan(0.4);
    expect(out.recall_strength).toBe("weak");
  });
});
