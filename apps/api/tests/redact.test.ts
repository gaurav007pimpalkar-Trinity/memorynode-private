import { describe, expect, it } from "vitest";
import { redact } from "../src/index.js";

describe("redact helper", () => {
  it("redacts authorization headers", () => {
    const input = { Authorization: "Bearer secret", "x-api-key": "abc123" };
    const out = redact(input) as Record<string, string>;
    expect(out.Authorization).toBe("***REDACTED***");
    expect(out["x-api-key"]).toBe("***REDACTED***");
  });

  it("redacts nested secrets", () => {
    const input = { inner: { token: "tok", ok: "safe" } };
    const out = redact(input) as { inner: { token: string; ok: string } };
    expect(out.inner.token).toBe("***REDACTED***");
    expect(out.inner.ok).toBe("safe");
  });
});
