import { describe, expect, it } from "vitest";
import { applyLaunchFloorToPlanLimits, getLimitsForPlanCode, minUsageCaps } from "../src/plans.js";

describe("minUsageCaps", () => {
  it("takes per-dimension minimum", () => {
    expect(
      minUsageCaps(
        { writes: 100, reads: 2000, embeds: 50 },
        { writes: 250, reads: 1000, embeds: 500 },
      ),
    ).toEqual({ writes: 100, reads: 1000, embeds: 50 });
  });
});

describe("applyLaunchFloorToPlanLimits", () => {
  it("floors deploy limits to Launch or below on quota fields", () => {
    const deploy = getLimitsForPlanCode("deploy");
    const launch = getLimitsForPlanCode("launch");
    const floored = applyLaunchFloorToPlanLimits(deploy);
    expect(floored.writes_per_day).toBe(launch.writes_per_day);
    expect(floored.extraction_calls_per_day).toBe(launch.extraction_calls_per_day);
    expect(floored.max_text_chars).toBe(launch.max_text_chars);
    expect(floored.overage_writes_per_1k_inr).toBe(deploy.overage_writes_per_1k_inr);
  });

  it("is idempotent on Launch", () => {
    const launch = getLimitsForPlanCode("launch");
    expect(applyLaunchFloorToPlanLimits(launch)).toEqual(launch);
  });
});
