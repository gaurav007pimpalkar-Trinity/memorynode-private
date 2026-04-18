import { describe, expect, it } from "vitest";
import { detectPiiHints } from "../src/piiHints.js";

describe("detectPiiHints", () => {
  it("returns email when an address-like token is present", () => {
    expect(detectPiiHints("Reach me at user.name+tag@example.co.uk today")).toEqual(["email"]);
  });

  it("returns phone for common US-style numbers", () => {
    expect(detectPiiHints("callback 415-555-0100")).toEqual(["phone"]);
  });

  it("returns both when both patterns match", () => {
    const hints = detectPiiHints("Email a@b.co or dial +14155550100");
    expect(hints).toContain("email");
    expect(hints).toContain("phone");
    expect(hints.length).toBe(2);
  });

  it("returns empty when no hints", () => {
    expect(detectPiiHints("nothing sensitive here")).toEqual([]);
  });
});
