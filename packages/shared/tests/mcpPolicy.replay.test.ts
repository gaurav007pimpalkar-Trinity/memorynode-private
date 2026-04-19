import { describe, expect, it } from "vitest";
import { McpPolicyEngine, type PolicyInput } from "../src/mcpPolicy.js";

const scope = {
  workspaceId: "w1",
  keyId: "k1",
  userId: "u1",
  namespace: "n1",
  sessionId: "s1",
};

function writeInput(nowMs: number, nonce: string, timestampMs = nowMs, actionId: PolicyInput["actionId"] = "memory.save"): PolicyInput {
  return {
    actionId,
    scope,
    nowMs,
    contentText: `user likes deterministic systems and logs ${nonce}`,
    nonce,
    timestampMs,
  };
}

describe("replay hardening", () => {
  it("rejects nonce reuse within TTL", () => {
    const engine = new McpPolicyEngine({
      replayWindowMs: 60_000,
      maxNonceEntries: 5,
      sessionWriteCalls: 20,
      keyWriteCalls: 20,
      scopeWriteCalls: 20,
      scopeWriteBurstLimit: 20,
      maxInFlightPerKey: 100,
      maxInFlightPerScope: 100,
    });
    expect(engine.evaluate(writeInput(1_000, "abc-123", 1_000, "memory.forget")).status).toBe("allow");
    const out = engine.evaluate(writeInput(1_100, "abc-123", 1_100, "memory.forget"));
    expect(out.status).toBe("deny");
    expect(out.reasonCode).toBe("replay_detected");
  });

  it("accepts fresh nonce after expiry", () => {
    const engine = new McpPolicyEngine({
      replayWindowMs: 1_000,
      maxNonceEntries: 5,
      sessionWriteCalls: 20,
      keyWriteCalls: 20,
      scopeWriteCalls: 20,
      scopeWriteBurstLimit: 20,
      maxInFlightPerKey: 100,
      maxInFlightPerScope: 100,
    });
    expect(engine.evaluate(writeInput(1_000, "abc-123", 1_000, "memory.forget")).status).toBe("allow");
    const out = engine.evaluate(writeInput(2_500, "abc-123", 2_500, "memory.forget"));
    expect(out.status === "allow" || out.status === "degrade").toBe(true);
  });

  it("keeps bounded nonce store behavior", () => {
    const engine = new McpPolicyEngine({
      replayWindowMs: 60_000,
      maxNonceEntries: 2,
      sessionWriteCalls: 20,
      keyWriteCalls: 20,
      scopeWriteCalls: 20,
      scopeWriteBurstLimit: 20,
      scopeForgetCalls: 20,
      maxInFlightPerKey: 100,
      maxInFlightPerScope: 100,
    });
    expect(engine.evaluate(writeInput(1_000, "n1", 1_000, "memory.forget")).status).toBe("allow");
    expect(engine.evaluate(writeInput(1_010, "n2", 1_010, "memory.forget")).status).toBe("allow");
    expect(engine.evaluate(writeInput(1_020, "n3", 1_020, "memory.forget")).status).toBe("allow");
    const out = engine.evaluate(writeInput(1_030, "n1", 1_030, "memory.forget"));
    expect(out.reasonCode).not.toBe("rate_limit_exceeded");
  });
});
