import type { HostedPlanGateFn } from "../adapters/hosted.js";
import type { HostedAuthContext } from "../types/workerBridge.js";

/** Worker env subset read by hosted MCP tier gates (`apps/api` Cloudflare bindings). */
export type HostedMcpPlanGateEnv = {
  MCP_AUDIT_LOG_REQUIRES_TEAM?: string;
  MCP_CONNECTOR_SETTINGS_REQUIRES_TEAM?: string;
};

function envMeansGateOff(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "false";
}

/**
 * Tier checks that run **before** REST/policy for selected tools (`HostedBrandedDeps.planGate`).
 * Indie/Studio/Team naming lives in PLAN §6 — today `HostedAuthContext.plan` is still `pro` | `team`; Team tier maps to product Team.
 */
export function createHostedMcpPlanGate(env: HostedMcpPlanGateEnv): HostedPlanGateFn {
  return (tool: string, ha: HostedAuthContext) =>
    evaluateHostedMcpPlanGate(tool, ha, env);
}

/** Pure helper for tests and callers that already have `env`. */
export function evaluateHostedMcpPlanGate(
  tool: string,
  ha: HostedAuthContext,
  env: HostedMcpPlanGateEnv,
): ReturnType<HostedPlanGateFn> {
  if (tool === "audit_log_list" && !envMeansGateOff(env.MCP_AUDIT_LOG_REQUIRES_TEAM) && ha.plan !== "team") {
    return {
      ok: false,
      code: "plan_gate",
      message:
        "audit_log_list requires a Team-plan workspace over MCP (set MCP_AUDIT_LOG_REQUIRES_TEAM=false to allow Studio-equivalent keys).",
    };
  }
  if (
    (tool === "connector_settings_get" || tool === "connector_settings_update") &&
    !envMeansGateOff(env.MCP_CONNECTOR_SETTINGS_REQUIRES_TEAM) &&
    ha.plan !== "team"
  ) {
    return {
      ok: false,
      code: "plan_gate",
      message:
        "connector settings tools require a Team-plan workspace over MCP (set MCP_CONNECTOR_SETTINGS_REQUIRES_TEAM=false to allow non-Team keys).",
    };
  }
  return { ok: true };
}
