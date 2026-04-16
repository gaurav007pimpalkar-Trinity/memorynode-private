import { describe, expect, it } from "vitest";
import { relativeBarPercents } from "../src/founderChartHelpers";

describe("relativeBarPercents", () => {
  it("scales so the larger value is 100%", () => {
    expect(relativeBarPercents(10, 40)).toEqual({ currentPct: 25, previousPct: 100 });
  });

  it("handles equal values", () => {
    expect(relativeBarPercents(50, 50)).toEqual({ currentPct: 100, previousPct: 100 });
  });

  it("uses a small denominator when both are zero", () => {
    const r = relativeBarPercents(0, 0);
    expect(r.currentPct).toBe(0);
    expect(r.previousPct).toBe(0);
  });

  it("treats non-finite as zero", () => {
    expect(relativeBarPercents(Number.NaN, 20)).toEqual({ currentPct: 0, previousPct: 100 });
  });
});
