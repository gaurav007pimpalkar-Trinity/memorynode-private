import { describe, expect, it } from "vitest";
import { McpPolicyEngine, estimateCost, type PolicyInput } from "../src/mcpPolicy.js";

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    actionId: "recall",
    scope: {
      workspaceId: "w1",
      keyId: "k1",
      userId: "u1",
      namespace: "n1",
      sessionId: "s1",
    },
    nowMs: 1000,
    queryText: "remember user preference for dark mode",
    topK: 5,
    ...overrides,
  };
}

describe("estimateCost", () => {
  it("is deterministic for identical input", () => {
    const a = estimateCost(input());
    const b = estimateCost(input());
    expect(a).toEqual(b);
  });
});

describe("McpPolicyEngine cost gate", () => {
  it("allows within budget", () => {
    const engine = new McpPolicyEngine({
      maxInputTokens: 1000,
      maxOutputTokens: 3000,
      maxTotalTokens: 3500,
    });
    const out = engine.evaluate(input());
    expect(out.status === "allow" || out.status === "degrade").toBe(true);
    expect(out.costDecision).not.toBe("deny");
  });

  it("degrades slight overage for context only", () => {
    const engine = new McpPolicyEngine({
      maxInputTokens: 1000,
      maxOutputTokens: 1200,
      maxTotalTokens: 1800,
    });
    const out = engine.evaluate(
      input({
        actionId: "context",
        queryText: "a".repeat(200),
        topK: 5,
      }),
    );
    expect(out.status).toBe("degrade");
    expect(out.costDecision).toBe("degrade");
    expect(out.truncateInstruction).toBeDefined();
  });

  it("denies far above budget", () => {
    const engine = new McpPolicyEngine({
      maxInputTokens: 100,
      maxOutputTokens: 300,
      maxTotalTokens: 350,
    });
    const out = engine.evaluate(
      input({
        actionId: "recall",
        queryText: "x".repeat(5000),
        topK: 10,
      }),
    );
    expect(out.status).toBe("deny");
    expect(out.reasonCode).toBe("cost_exceeded");
    expect(out.estimatedTokens).toBeTypeOf("number");
    expect(out.budget?.max_total_tokens).toBe(350);
  });

  it("enforces exact boundaries", () => {
    const probe = estimateCost(input({ actionId: "context", queryText: "abcd", topK: 1 }));
    const engine = new McpPolicyEngine({
      maxInputTokens: probe.inputTokens,
      maxOutputTokens: probe.outputTokens,
      maxTotalTokens: probe.totalTokens,
    });
    const out = engine.evaluate(input({ actionId: "context", queryText: "abcd", topK: 1 }));
    expect(out.status === "allow" || out.status === "degrade").toBe(true);
    expect(out.reasonCode).toBeUndefined();
  });
});
