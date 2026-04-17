import { describe, expect, it } from "vitest";
import { ApiClientError, userFacingErrorMessage } from "../src/apiClient";

describe("api client failure UX mapping", () => {
  it("maps rate limit errors to user-safe guidance", () => {
    const err = new ApiClientError(429, "RATE_LIMITED", "rate limited");
    expect(userFacingErrorMessage(err)).toContain("Too many requests");
  });

  it("maps unauthorized to re-auth guidance", () => {
    const err = new ApiClientError(401, "UNAUTHORIZED", "unauthorized");
    expect(userFacingErrorMessage(err)).toContain("Session expired");
  });

  it("maps transport failures to connectivity guidance", () => {
    const err = new TypeError("Failed to fetch");
    expect(userFacingErrorMessage(err)).toContain("Unable to reach the server");
  });
});
