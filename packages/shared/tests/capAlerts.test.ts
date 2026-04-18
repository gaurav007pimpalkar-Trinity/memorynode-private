import { describe, expect, it } from "vitest";
import { computeOperationalMode, computeUsageCapAlerts } from "../src/capAlerts.js";

describe("computeUsageCapAlerts", () => {
  const baseCaps = { writes: 100, reads: 1000, embeds: 500 };

  it("returns empty when all ratios are below warning", () => {
    expect(
      computeUsageCapAlerts({
        writes: 10,
        reads: 100,
        embeds: 50,
        embed_tokens: 1000,
        extraction_calls: 0,
        gen_tokens: 0,
        storage_bytes: 0,
        caps: baseCaps,
        embed_tokens_cap: 1_000_000,
        extraction_calls_cap: 100,
        gen_tokens_cap: 1_000_000,
        storage_bytes_cap: 1_000_000_000,
      }),
    ).toEqual([]);
  });

  it("emits warning when a dimension crosses 80%", () => {
    const alerts = computeUsageCapAlerts({
        writes: 85,
        reads: 0,
        embeds: 0,
        embed_tokens: 0,
        extraction_calls: 0,
        gen_tokens: 0,
        storage_bytes: 0,
        caps: baseCaps,
        embed_tokens_cap: 1_000_000,
        extraction_calls_cap: 100,
        gen_tokens_cap: 1_000_000,
        storage_bytes_cap: 1_000_000_000,
      });
    expect(alerts).toEqual([
      expect.objectContaining({ resource: "writes", severity: "warning", cap: 100, used: 85 }),
    ]);
  });

  it("emits critical at or above 95%", () => {
    const alerts = computeUsageCapAlerts({
        writes: 96,
        reads: 0,
        embeds: 0,
        embed_tokens: 0,
        extraction_calls: 0,
        gen_tokens: 0,
        storage_bytes: 0,
        caps: baseCaps,
        embed_tokens_cap: 1_000_000,
        extraction_calls_cap: 100,
        gen_tokens_cap: 1_000_000,
        storage_bytes_cap: 1_000_000_000,
      });
    expect(alerts.some((a) => a.resource === "writes" && a.severity === "critical")).toBe(true);
  });

  it("treats at or over cap as critical", () => {
    const alerts = computeUsageCapAlerts({
        writes: 100,
        reads: 2000,
        embeds: 0,
        embed_tokens: 0,
        extraction_calls: 0,
        gen_tokens: 0,
        storage_bytes: 0,
        caps: baseCaps,
        embed_tokens_cap: 1_000_000,
        extraction_calls_cap: 100,
        gen_tokens_cap: 1_000_000,
        storage_bytes_cap: 1_000_000_000,
      });
    const reads = alerts.find((a) => a.resource === "reads");
    expect(reads?.severity).toBe("critical");
    expect(reads?.ratio).toBeGreaterThanOrEqual(1);
  });

  it("computeOperationalMode returns degraded when entitlement telemetry fails", () => {
    expect(computeOperationalMode({ degradedEntitlements: true, capAlerts: [] })).toBe("degraded");
  });

  it("computeOperationalMode returns degraded on billing grace soft downgrade", () => {
    expect(computeOperationalMode({ degradedEntitlements: false, graceSoftDowngrade: true, capAlerts: [] })).toBe(
      "degraded",
    );
  });

  it("computeOperationalMode returns sleep on critical core cap", () => {
    expect(
      computeOperationalMode({
        degradedEntitlements: false,
        capAlerts: [{ resource: "reads", severity: "critical", used: 99, cap: 100, ratio: 0.99 }],
      }),
    ).toBe("sleep");
  });

  it("computeOperationalMode returns degraded on warning only", () => {
    expect(
      computeOperationalMode({
        degradedEntitlements: false,
        capAlerts: [{ resource: "embed_tokens", severity: "warning", used: 8, cap: 10, ratio: 0.8 }],
      }),
    ).toBe("degraded");
  });

  it("skips dimensions with zero cap", () => {
    const alerts = computeUsageCapAlerts({
        writes: 0,
        reads: 0,
        embeds: 0,
        embed_tokens: 0,
        extraction_calls: 0,
        gen_tokens: 999,
        storage_bytes: 0,
        caps: baseCaps,
        embed_tokens_cap: 1_000_000,
        extraction_calls_cap: 100,
        gen_tokens_cap: 0,
        storage_bytes_cap: 0,
      });
    expect(alerts.every((a) => a.resource !== "gen_tokens" && a.resource !== "storage")).toBe(true);
  });
});
