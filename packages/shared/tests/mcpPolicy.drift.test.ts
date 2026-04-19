import { describe, expect, it } from "vitest";
import { McpPolicyEngine, type PolicyInput } from "../src/mcpPolicy.js";

function input(query: string, nowMs: number): PolicyInput {
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

describe("drift-resistant loop detection", () => {
  it("rejects slow semantic drift loops", () => {
    const engine = new McpPolicyEngine({
      similarityThreshold: 0.98,
      driftSimilarityThreshold: 0.2,
      driftScoreThreshold: 0.15,
      driftDecayHalfLifeMs: 120_000,
      loopThreshold: 4,
    });

    const q = [
      "what does user prefer for theme",
      "tell me user preferred theme style",
      "which ui style does user usually pick",
      "describe visual style user tends to choose",
    ];
    expect(engine.evaluate(input(q[0], 1_000)).status).toBe("allow");
    engine.complete(input(q[0], 1_000));
    expect(engine.evaluate(input(q[1], 2_000)).status).toBe("allow");
    engine.complete(input(q[1], 2_000));
    const third = engine.evaluate(input(q[2], 3_000));
    const out = third.status === "deny" ? third : engine.evaluate(input(q[3], 4_000));
    expect(out.status).toBe("deny");
    expect(out.reasonCode).toBe("loop_detected_drift");
  });

  it("decays drift score across long idle windows", () => {
    const engine = new McpPolicyEngine({
      similarityThreshold: 0.98,
      driftSimilarityThreshold: 0.45,
      driftScoreThreshold: 0.7,
      driftDecayHalfLifeMs: 1_000,
      loopThreshold: 5,
    });
    expect(engine.evaluate(input("user communication preference", 1_000)).status).toBe("allow");
    engine.complete(input("user communication preference", 1_000));
    expect(engine.evaluate(input("preferred communication style for user", 1_500)).status).toBe("allow");
    engine.complete(input("preferred communication style for user", 1_500));
    const out = engine.evaluate(input("deployment rollback procedure", 20_000));
    expect(out.status === "allow" || out.status === "degrade").toBe(true);
  });
});
