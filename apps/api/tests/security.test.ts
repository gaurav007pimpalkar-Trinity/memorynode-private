/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { assertBodySize, isOriginAllowed, parseAllowedOrigins } from "../src/index.js";
import { makeCorsHeaders } from "../src/index.js";

describe("CORS allowlist", () => {
  it("allows when allowlist empty", () => {
    expect(isOriginAllowed("https://example.com", null)).toBe(true);
  });

  it("respects allowlist", () => {
    const allowed = ["https://a.com", "https://b.com"];
    expect(isOriginAllowed("https://a.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://c.com", allowed)).toBe(false);
  });

  it("origin headers emitted per rules", () => {
    expect(makeCorsHeaders("https://x.com", null)).toEqual({});
    expect(makeCorsHeaders("https://x.com", ["*"])).toMatchObject({
      "access-control-allow-origin": "*",
      vary: "Origin",
      "access-control-max-age": "600",
    });
    expect(makeCorsHeaders("https://a.com", ["https://a.com"])).toMatchObject({
      "access-control-allow-origin": "https://a.com",
      "access-control-allow-credentials": "true",
      vary: "Origin",
      "access-control-allow-methods": "GET,POST,OPTIONS,DELETE",
    });
    expect(makeCorsHeaders("https://b.com", ["https://a.com"])).toEqual({});
  });

  it("parseAllowedOrigins trims and filters", () => {
    expect(parseAllowedOrigins(" https://a.com , https://b.com")).toEqual(["https://a.com", "https://b.com"]);
    expect(parseAllowedOrigins("")).toBeNull();
  });
});

describe("Body size enforcement", () => {
  it("rejects payload larger than limit", async () => {
    const req = new Request("http://localhost", { method: "POST", body: "12345" });
    await expect(assertBodySize(req, { MAX_BODY_BYTES: "3" } as any)).rejects.toThrow();
  });

  it("passes small payload", async () => {
    const req = new Request("http://localhost", { method: "POST", body: "12" });
    await expect(assertBodySize(req, { MAX_BODY_BYTES: "5" } as any)).resolves.toBeUndefined();
  });

  it("rejects large payload without content-length header", async () => {
    const large = "x".repeat(20);
    const req = new Request("http://localhost", { method: "POST", body: large });
    await expect(assertBodySize(req, { MAX_BODY_BYTES: "10" } as any)).rejects.toThrow();
  });
});
