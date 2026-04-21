export { MCP_POLICY_VERSION, TOOL_MANIFEST_VERSION } from "./version.js";
export type { ServiceContext } from "./services/types.js";
export type { HostedAuthContext, HostedWorkerEnv } from "./types/workerBridge.js";

export type {
  HostedBrandedDeps,
  HostedDirectListMemoriesFn,
  HostedDirectSearchFn,
  HostedMcpCacheLike,
  HostedPlanGateFn,
  InternalJsonFn,
  AliasBehaviorFn,
} from "./adapters/hosted.js";
export { MCP_STDIO_ADAPTER_PENDING } from "./adapters/stdio.js";

export {
  CANONICAL_ALIAS_TARGETS,
  createAliasBehavior,
  normalizeDeprecationPhase,
  resolveAliasDecision,
  type AliasBehaviorDeps,
  type AliasCanonicalKey,
} from "./aliases/deprecation.js";

export { mapHostedToolToPolicyActionId } from "./policy/mapToolToActionId.js";
export {
  createHostedMcpPlanGate,
  evaluateHostedMcpPlanGate,
  type HostedMcpPlanGateEnv,
} from "./policy/enforcePlanGate.js";

export {
  registerAllHostedTools,
  registerAllTools,
  HOSTED_CANONICAL_TOOL_NAMES,
  type HostedCanonicalToolName,
} from "./registry/registerAllTools.js";

export { MIN_DELETE_CONFIDENCE, normalizedConfidenceFromFusionScore } from "./hosted/helpers.js";
