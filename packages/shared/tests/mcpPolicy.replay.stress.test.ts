import { describe, expect, it } from "vitest";
import { McpPolicyEngine, type PolicyInput } from "../src/mcpPolicy.js";

function replayInput(nowMs: number, nonce: string): PolicyInput {
  return {
    actionId: "memory.forget",
    scope: {
      workspaceId: "w1",
      keyId: "k1",
      userId: "u1",
      namespace: "n1",
      sessionId: "s1",
    },
    nowMs,
    contentText: `forget candidate ${nonce}`,
    nonce,
    timestampMs: nowMs,
  };
}

describe("replay stress", () => {
  it("rejects reused nonces under rapid calls", () => {
    const engine = new McpPolicyEngine({
      replayWindowMs: 60_000,
      maxNonceEntries: 500,
      sessionWriteCalls: 1000,
      keyWriteCalls: 1000,
      scopeWriteCalls: 1000,
      scopeForgetCalls: 1000,
      scopeWriteBurstLimit: 1000,
      maxInFlightPerKey: 1000,
      maxInFlightPerScope: 1000,
    });
    let replayRejects = 0;
    for (let i = 0; i < 150; i++) {
      const nonce = i % 3 === 0 ? "reuse-fixed" : `nonce-${i}`;
      const out = engine.evaluate(replayInput(1_000 + i, nonce));
      if (out.reasonCode === "replay_detected") replayRejects += 1;
      if (out.status !== "deny") engine.complete(replayInput(1_000 + i, nonce));
    }
    expect(replayRejects).toBeGreaterThan(0);
  });

  it("maintains bounded behavior around eviction edges", () => {
    const engine = new McpPolicyEngine({
      replayWindowMs: 60_000,
      maxNonceEntries: 20,
      sessionWriteCalls: 1000,
      keyWriteCalls: 1000,
      scopeWriteCalls: 1000,
      scopeForgetCalls: 1000,
      scopeWriteBurstLimit: 1000,
      maxInFlightPerKey: 1000,
      maxInFlightPerScope: 1000,
    });
    const start = Date.now();
    for (let i = 0; i < 400; i++) {
      const nonce = `edge-${i % 40}`;
      const out = engine.evaluate(replayInput(10_000 + i * 10, nonce));
      if (out.status !== "deny") engine.complete(replayInput(10_000 + i * 10, nonce));
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500);
  });
});
