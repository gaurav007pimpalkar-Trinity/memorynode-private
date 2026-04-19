import { describe, expect, it } from "vitest";
import { normalizeDeprecationPhase, resolveAliasDecision } from "../src/mcpAliasDeprecation.js";

describe("alias deprecation phase", () => {
  it("allow phase passes silently", () => {
    const phase = normalizeDeprecationPhase("allow");
    const d = resolveAliasDecision(phase, "recall");
    expect(d).toEqual({ blocked: false });
  });

  it("warn phase includes warning payload", () => {
    const phase = normalizeDeprecationPhase("warn");
    const d = resolveAliasDecision(phase, "context");
    expect(d.blocked).toBe(false);
    expect(d.warning).toEqual({ warning: "deprecated_tool", use: "context" });
  });

  it("block phase rejects alias", () => {
    const phase = normalizeDeprecationPhase("block");
    const d = resolveAliasDecision(phase, "memory");
    expect(d).toEqual({ blocked: true });
  });
});
