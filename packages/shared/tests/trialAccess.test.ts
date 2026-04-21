import { describe, expect, it } from "vitest";
import { trialExpiredBlocksWrites } from "../src/trialAccess.js";

describe("trialExpiredBlocksWrites", () => {
  it("returns false when not on trial", () => {
    expect(trialExpiredBlocksWrites({ trial: false, trialExpiresAt: "2000-01-01T00:00:00.000Z" })).toBe(false);
    expect(trialExpiredBlocksWrites({ trialExpiresAt: "2000-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("returns false when trial but no expiry set", () => {
    expect(trialExpiredBlocksWrites({ trial: true, trialExpiresAt: null })).toBe(false);
    expect(trialExpiredBlocksWrites({ trial: true })).toBe(false);
  });

  it("returns false when expiry is in the future", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(trialExpiredBlocksWrites({ trial: true, trialExpiresAt: future })).toBe(false);
  });

  it("returns true when trial and expiry is in the past", () => {
    expect(trialExpiredBlocksWrites({ trial: true, trialExpiresAt: "2000-01-01T00:00:00.000Z" })).toBe(true);
  });

  it("returns false for invalid date string", () => {
    expect(trialExpiredBlocksWrites({ trial: true, trialExpiresAt: "not-a-date" })).toBe(false);
  });
});
