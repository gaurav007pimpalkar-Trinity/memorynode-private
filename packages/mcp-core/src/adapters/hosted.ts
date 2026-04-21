import type { McpPolicyEngine, McpActionId, PolicyInput, PolicyScope } from "@memorynodeai/shared";
import type { HostedAuthContext } from "../types/workerBridge.js";

/** First argument is Worker env at runtime (`apps/api` `Env`); typed loosely to avoid importing the Worker graph into mcp-core. */
export type InternalJsonFn = (
  env: unknown,
  origin: string,
  apiKey: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  requestId?: string,
) => Promise<{ ok: boolean; status: number; data: unknown }>;

/** Structural match for apps/api `McpResponseCache` without creating an API → mcp-core dependency. */
export interface HostedMcpCacheLike {
  makeKey(args: {
    tool: "recall" | "context";
    scope: string;
    query: string;
    policyVersion: string;
  }): string;
  getOrCompute<T>(
    key: string,
    args: { tool: "recall" | "context"; scope: string },
    compute: () => Promise<T>,
  ): Promise<{ value: T; cacheHit: boolean }>;
}

export type PolicyEvaluateResult = ReturnType<McpPolicyEngine["evaluate"]>;

export type AliasBehaviorFn = (
  alias: string,
  /** Legacy stable name shown to policy / warnings during migration (see docs/PLAN.md alias table). */
  canonicalForPolicy: string,
) =>
  | { blocked: true; response: ReturnType<typeof import("../hosted/policyResponses.js").toolError> }
  | { blocked: false; warning?: { warning: "deprecated_tool"; use: string } };

/** Optional in-process search/list (apps/api): avoids Worker→REST double-hop for hosted MCP hot paths. */
export type HostedDirectSearchFn = (args: {
  user_id: string;
  namespace: string;
  query: string;
  top_k: number;
}) => Promise<{ ok: boolean; status: number; data: unknown }>;

export type HostedDirectListMemoriesFn = (args: {
  user_id: string;
  namespace: string;
  page: number;
  page_size: number;
}) => Promise<{ ok: boolean; status: number; data: unknown }>;

/** SOC2-oriented MCP-side tier gate before REST (REST still enforces quota). See Sprint S6 / PLAN §6. */
export type HostedPlanGateFn = (
  tool: string,
  auth: HostedAuthContext,
) => { ok: true } | { ok: false; code: string; message: string };

export type HostedBrandedDeps = {
  env: unknown;
  restApiOrigin: string;
  apiKey: string;
  auth: HostedAuthContext;
  defaultUserId: string;
  defaultNamespace: string;
  requestId: string;
  getSessionId: () => string;
  hostedPolicy: McpPolicyEngine;
  internalJson: InternalJsonFn;
  /** When set with list, recall/search/context_pack prefer direct services over {@link InternalJsonFn}. */
  hostedDirectSearch?: HostedDirectSearchFn;
  hostedDirectListMemories?: HostedDirectListMemoriesFn;
  mcpCache: HostedMcpCacheLike;
  logger: { info: (payload: Record<string, unknown>) => void };
  MCP_POLICY_VERSION: string;
  TOOL_MANIFEST_VERSION: string;
  invalidateScopeCache: (workspaceId: string, userId: string, namespace: string) => void;
  resolveScope: (containerTag?: string | null) => { user_id: string; namespace: string };
  toPolicyScope: (scope: { user_id: string; namespace: string }) => PolicyScope;
  evaluateWithLog: (
    actionId: McpActionId,
    input: Omit<PolicyInput, "actionId" | "scope" | "nowMs"> & { scope: PolicyScope },
  ) => PolicyEvaluateResult;
  aliasBehavior: AliasBehaviorFn;
  /** When set, runs before Group 6 usage/billing tools (e.g. audit tier). */
  planGate?: HostedPlanGateFn;
};
