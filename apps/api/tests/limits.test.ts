import { capsByPlan, exceedsCaps, UsageSnapshot, UsageDelta } from "../src/limits.js";
import { safeKvTtl } from "../src/index.js";

describe("capsByPlan", () => {
  it("has expected free limits", () => {
    expect(capsByPlan.free).toEqual({ writes: 200, reads: 500, embeds: 2000 });
  });

  it("has expected pro limits", () => {
    expect(capsByPlan.pro).toEqual({ writes: 2000, reads: 5000, embeds: 20000 });
  });

  it("has expected team limits", () => {
    expect(capsByPlan.team).toEqual({ writes: 10000, reads: 20000, embeds: 100000 });
  });
});

describe("exceedsCaps", () => {
  const usage: UsageSnapshot = { writes: 0, reads: 0, embeds: 0 };

  it("allows within caps", () => {
    const delta: UsageDelta = { writesDelta: 1, readsDelta: 1, embedsDelta: 1 };
    expect(exceedsCaps(capsByPlan.free, usage, delta)).toBe(false);
  });

  it("blocks when writes exceed", () => {
    const delta: UsageDelta = { writesDelta: capsByPlan.free.writes + 1, readsDelta: 0, embedsDelta: 0 };
    expect(exceedsCaps(capsByPlan.free, usage, delta)).toBe(true);
  });

  it("blocks when embeds exceed pro cap", () => {
    const delta: UsageDelta = { writesDelta: 0, readsDelta: 0, embedsDelta: capsByPlan.pro.embeds + 1 };
    expect(exceedsCaps(capsByPlan.pro, usage, delta)).toBe(true);
  });
});

describe("safeKvTtl", () => {
  it("enforces minimum 60s", () => {
    expect(safeKvTtl(10)).toBe(60);
    expect(safeKvTtl(59)).toBe(60);
  });

  it("ceil to integer", () => {
    expect(safeKvTtl(60.1)).toBe(61);
    expect(safeKvTtl(120.4)).toBe(121);
  });

  it("handles invalid numbers", () => {
    expect(safeKvTtl(NaN)).toBe(60);
    expect(safeKvTtl(-5)).toBe(60);
  });
});
