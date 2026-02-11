import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger redaction", () => {
  it("does not leak authorization or API key values", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info({
      event: "redaction_check",
      request_id: "req-1",
      headers: {
        authorization: "Bearer really-secret-token-value",
        "x-api-key": "mn_test_key_12345",
      },
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("\"event_name\":\"redaction_check\"");
    expect(line).toContain("\"request_id\":\"req-1\"");
    expect(line).not.toContain("really-secret-token-value");
    expect(line).not.toContain("mn_test_key_12345");
    expect(line).toContain("***REDACTED***");
  });

  it("redacts secrets inside error payloads", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error({
      event: "request_failed",
      request_id: "req-2",
      err: new Error("authorization bearer sk-live-secret"),
    });

    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = String(errSpy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("\"event_name\":\"request_failed\"");
    expect(line).not.toContain("sk-live-secret");
    expect(line).toContain("***REDACTED***");
  });
});
