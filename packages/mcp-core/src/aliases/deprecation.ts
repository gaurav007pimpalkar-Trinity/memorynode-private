import {
  normalizeDeprecationPhase,
  resolveAliasDecision,
  type DeprecationPhase,
} from "@memorynodeai/shared";
import { toolError } from "../hosted/policyResponses.js";

/** Canonical targets for deprecated entrypoints (snake_case per docs/PLAN.md). */
export const CANONICAL_ALIAS_TARGETS = {
  memory: "memory_save",
  recall: "search",
  memory_search: "search",
  memory_insert: "memory_save",
  memory_context: "context_pack",
  whoami: "identity_get",
  whoAmI: "identity_get",
} as const;

export type AliasCanonicalKey = keyof typeof CANONICAL_ALIAS_TARGETS;

export { normalizeDeprecationPhase, resolveAliasDecision };

export type AliasBehaviorDeps = {
  deprecationPhase: DeprecationPhase;
  // Structural logging payload varies by caller (apps/api uses InfoPayload).
  logger: { info: (payload: Record<string, unknown>) => void };
  auth: { workspaceId: string };
  requestId: string;
};

export function createAliasBehavior(deps: AliasBehaviorDeps) {
  return (alias: string, canonical: string) => {
    deps.logger.info({
      event: "mcp_alias_usage",
      alias,
      canonical,
      phase: deps.deprecationPhase,
      workspace_id: deps.auth.workspaceId,
      request_id: deps.requestId,
    });
    const decision = resolveAliasDecision(deps.deprecationPhase, canonical);
    if (decision.blocked) {
      return {
        blocked: true as const,
        response: toolError("weak_signal", `Deprecated tool '${alias}' is blocked. Use '${canonical}'.`, {
          warning: "deprecated_tool",
          use: canonical,
        }),
      };
    }
    return { blocked: false as const, warning: decision.warning };
  };
}
