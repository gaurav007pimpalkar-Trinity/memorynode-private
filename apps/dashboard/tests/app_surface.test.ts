import { describe, expect, it } from "vitest";
import { isFounderPath, normalizePathname } from "../src/appSurface";

describe("appSurface path helpers", () => {
  it("normalizes empty and trailing slash paths", () => {
    expect(normalizePathname("")).toBe("/");
    expect(normalizePathname("/founder/")).toBe("/founder");
    expect(normalizePathname("/")).toBe("/");
  });

  it("detects founder paths only for /founder routes", () => {
    expect(isFounderPath("/founder")).toBe(true);
    expect(isFounderPath("/founder/metrics")).toBe(true);
    expect(isFounderPath("/")).toBe(false);
    expect(isFounderPath("/overview")).toBe(false);
  });
});
