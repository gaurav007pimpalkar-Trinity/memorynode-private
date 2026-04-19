import { describe, expect, it } from "vitest";
import { McpPolicyEngine } from "../src/mcpPolicy.js";
import { runAttackSimulation } from "../src/mcpAttackSimulator.js";

describe("runAttackSimulation", () => {
  it("simulates loop attack", () => {
    const report = runAttackSimulation({
      attackType: "loop_spam",
      steps: 8,
      policy: new McpPolicyEngine({ loopThreshold: 3, similarityThreshold: 0.9 }),
    });
    expect(report.total_calls).toBe(8);
    expect(report.rejected).toBeGreaterThan(0);
    expect(report.policy_triggers.loop_detected ?? 0).toBeGreaterThan(0);
  });

  it("simulates cost fragmentation attack", () => {
    const report = runAttackSimulation({
      attackType: "fragmented_cost_attack",
      steps: 12,
      policy: new McpPolicyEngine({
        maxTotalTokens: 2_000,
        maxTokensPerSessionWindow: 6_000,
        sessionBudgetWindowMs: 120_000,
      }),
    });
    expect(report.total_cost_estimate).toBeGreaterThan(0);
    expect(report.rejected).toBeGreaterThan(0);
  });

  it("simulates replay attack", () => {
    const report = runAttackSimulation({
      attackType: "replay_attempts",
      steps: 6,
      policy: new McpPolicyEngine({
        replayWindowMs: 60_000,
        sessionWriteCalls: 30,
        keyWriteCalls: 30,
        scopeWriteCalls: 30,
        scopeForgetCalls: 30,
        scopeWriteBurstLimit: 30,
      }),
    });
    expect(report.rejected).toBeGreaterThan(0);
    expect(report.policy_triggers.replay_detected ?? 0).toBeGreaterThan(0);
  });

  it("simulates mixed attack", () => {
    const report = runAttackSimulation({
      attackType: "mixed_attack",
      steps: 20,
      policy: new McpPolicyEngine({
        loopThreshold: 3,
        similarityThreshold: 0.85,
        maxTokensPerSessionWindow: 7_000,
        sessionBudgetWindowMs: 120_000,
      }),
    });
    expect(report.total_calls).toBe(20);
    expect(report.accepted + report.rejected).toBe(20);
    expect(report.failures.length).toBe(report.rejected);
  });
});
