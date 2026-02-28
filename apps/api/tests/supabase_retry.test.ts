/**
 * Supabase retry helper: retries on transient errors, does not retry on permanent errors.
 */

import { describe, expect, it } from "vitest";
import { withSupabaseRetry, withSupabaseQueryRetry } from "../src/supabaseRetry.js";

describe("withSupabaseRetry", () => {
  it("returns result when fn succeeds", async () => {
    const result = await withSupabaseRetry(async () => "ok");
    expect(result).toBe("ok");
  });

  it("throws when fn throws non-retryable error", async () => {
    await expect(
      withSupabaseRetry(async () => {
        throw new Error("PGRST116 no rows");
      }),
    ).rejects.toThrow("PGRST116");
  });

  it("retries and eventually throws when all retries fail with retryable error", async () => {
    let attempts = 0;
    await expect(
      withSupabaseRetry(
        async () => {
          attempts++;
          throw new Error("fetch failed timeout");
        },
        { maxRetries: 2, delaysMs: [10, 10] },
      ),
    ).rejects.toThrow("fetch failed");
    expect(attempts).toBe(3);
  });

  it("succeeds on second attempt after transient error", async () => {
    let attempts = 0;
    const result = await withSupabaseRetry(
      async () => {
        attempts++;
        if (attempts < 2) throw new Error("ECONNRESET");
        return 42;
      },
      { maxRetries: 2, delaysMs: [10, 10] },
    );
    expect(result).toBe(42);
    expect(attempts).toBe(2);
  });
});

describe("withSupabaseQueryRetry", () => {
  it("returns result when query has no error", async () => {
    const out = await withSupabaseQueryRetry(async () => ({ data: { id: 1 }, error: null }));
    expect(out.data).toEqual({ id: 1 });
    expect(out.error).toBeNull();
  });

  it("returns error when query has non-retryable error", async () => {
    const err = { code: "PGRST116", message: "no rows" };
    const out = await withSupabaseQueryRetry(async () => ({ data: null, error: err }));
    expect(out.error).toEqual(err);
  });

  it("retries and returns error when all retries fail with retryable error", async () => {
    let attempts = 0;
    const out = await withSupabaseQueryRetry(
      async () => {
        attempts++;
        return { data: null, error: { message: "connection timeout" } };
      },
      { maxRetries: 2, delaysMs: [10, 10] },
    );
    expect(out.error).toEqual({ message: "connection timeout" });
    expect(attempts).toBe(3);
  });
});
