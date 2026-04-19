import { describe, expect, it } from "vitest";
import { McpPolicyEngine, type PolicyInput } from "../src/mcpPolicy.js";

function makeInput(nowMs: number, query: string): PolicyInput {
  return {
    actionId: "context",
    scope: {
      workspaceId: "w1",
      keyId: "k1",
      userId: "u1",
      namespace: "n1",
      sessionId: "s1",
    },
    nowMs,
    queryText: query,
    topK: 1,
  };
}

describe("session-level cost budget", () => {
  it("rejects when rolling session budget is exceeded", () => {
    const engine = new McpPolicyEngine({
      maxTokensPerSessionWindow: 1500,
      sessionBudgetWindowMs: 60_000,
      maxTotalTokens: 5000,
      maxOutputTokens: 5000,
      maxInputTokens: 3000,
    });
    const a = engine.evaluate(makeInput(1_000, "a".repeat(40)));
    expect(a.status === "allow" || a.status === "degrade").toBe(true);
    engine.complete(makeInput(1_000, "a".repeat(40)));
    const b = engine.evaluate(makeInput(2_000, "b".repeat(40)));
    expect(b.status === "allow" || b.status === "degrade").toBe(true);
    engine.complete(makeInput(2_000, "b".repeat(40)));
    const c = engine.evaluate(makeInput(3_000, "c".repeat(40)));
    expect(c.status).toBe("deny");
    expect(c.reasonCode).toBe("cost_exceeded_session");
  });

  it("allows exactly at threshold and then prunes by window", () => {
    const engine = new McpPolicyEngine({
      maxTokensPerSessionWindow: 1100,
      sessionBudgetWindowMs: 2_000,
      maxTotalTokens: 5000,
      maxOutputTokens: 5000,
      maxInputTokens: 3000,
    });
    const first = engine.evaluate(makeInput(1_000, "x".repeat(20)));
    expect(first.status === "allow" || first.status === "degrade").toBe(true);
    engine.complete(makeInput(1_000, "x".repeat(20)));
    const second = engine.evaluate(makeInput(1_900, "y".repeat(20)));
    expect(second.status === "allow" || second.status === "degrade").toBe(true);
    engine.complete(makeInput(1_900, "y".repeat(20)));
    const afterWindow = engine.evaluate(makeInput(4_500, "z".repeat(20)));
    expect(afterWindow.status === "allow" || afterWindow.status === "degrade").toBe(true);
  });
});
