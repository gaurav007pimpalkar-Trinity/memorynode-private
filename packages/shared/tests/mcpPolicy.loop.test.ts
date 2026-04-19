import { describe, expect, it } from "vitest";
import { McpPolicyEngine, type PolicyInput } from "../src/mcpPolicy.js";

function makeInput(query: string, nowMs: number): PolicyInput {
  return {
    actionId: "recall",
    scope: {
      workspaceId: "w1",
      keyId: "k1",
      userId: "u1",
      namespace: "n1",
      sessionId: "s1",
    },
    nowMs,
    queryText: query,
    topK: 3,
  };
}

describe("rolling loop detection", () => {
  it("rejects repeated identical loops", () => {
    const engine = new McpPolicyEngine({ loopThreshold: 3, similarityThreshold: 0.9 });
    expect(engine.evaluate(makeInput("remember user favorite color", 1)).status).toBe("allow");
    const second = engine.evaluate(makeInput("remember user favorite color", 2));
    const out = second.status === "deny" ? second : engine.evaluate(makeInput("remember user favorite color", 3));
    expect(out.status).toBe("deny");
    expect(out.reasonCode).toBe("loop_detected");
    expect(out.loopConfidence).toBeGreaterThan(0.9);
    expect(Array.isArray(out.matchedWindow)).toBe(true);
  });

  it("rejects paraphrased loops", () => {
    const engine = new McpPolicyEngine({ loopThreshold: 2, similarityThreshold: 0.5 });
    expect(engine.evaluate(makeInput("what does user prefer for theme", 10)).status).toBe("allow");
    const step2 = engine.evaluate(makeInput("tell me theme preference of the user", 11));
    const out = step2.status === "deny" ? step2 : engine.evaluate(makeInput("user theme preference details", 12));
    expect(out.status).toBe("deny");
    expect(out.reasonCode).toBe("loop_detected");
  });

  it("allows normal topical shift", () => {
    const engine = new McpPolicyEngine({ loopThreshold: 3, similarityThreshold: 0.9 });
    expect(engine.evaluate(makeInput("user preference on dark mode", 20)).status).toBe("allow");
    expect(engine.evaluate(makeInput("recent invoice amount", 21)).status).toBe("allow");
    const out = engine.evaluate(makeInput("deployment date for project", 22));
    expect(out.status === "allow" || out.status === "degrade").toBe(true);
  });
});
