import { describe, expect, it } from "vitest";
import { evaluateHostedMcpPlanGate, type HostedMcpPlanGateEnv } from "../src/policy/enforcePlanGate.js";
import type { HostedAuthContext } from "../src/types/workerBridge.js";

const pro: HostedAuthContext = {
  workspaceId: "w1",
  keyHash: "h1",
  plan: "pro",
};

const team: HostedAuthContext = {
  workspaceId: "w1",
  keyHash: "h1",
  plan: "team",
};

const defaultEnv: HostedMcpPlanGateEnv = {};

describe("evaluateHostedMcpPlanGate", () => {
  it("allows all tools for team by default", () => {
    expect(evaluateHostedMcpPlanGate("audit_log_list", team, defaultEnv)).toEqual({ ok: true });
    expect(evaluateHostedMcpPlanGate("connector_settings_get", team, defaultEnv)).toEqual({ ok: true });
    expect(evaluateHostedMcpPlanGate("usage_today", pro, defaultEnv)).toEqual({ ok: true });
  });

  it("denies audit_log_list for pro when gate is on", () => {
    const r = evaluateHostedMcpPlanGate("audit_log_list", pro, defaultEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("plan_gate");
  });

  it("denies connector tools for pro when gate is on", () => {
    const a = evaluateHostedMcpPlanGate("connector_settings_get", pro, defaultEnv);
    const b = evaluateHostedMcpPlanGate("connector_settings_update", pro, defaultEnv);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });

  it("allows audit for pro when MCP_AUDIT_LOG_REQUIRES_TEAM is false", () => {
    const r = evaluateHostedMcpPlanGate("audit_log_list", pro, { MCP_AUDIT_LOG_REQUIRES_TEAM: "false" });
    expect(r).toEqual({ ok: true });
  });

  it("allows connector for pro when MCP_CONNECTOR_SETTINGS_REQUIRES_TEAM is false", () => {
    const r = evaluateHostedMcpPlanGate("connector_settings_get", pro, {
      MCP_CONNECTOR_SETTINGS_REQUIRES_TEAM: "false",
    });
    expect(r).toEqual({ ok: true });
  });
});
