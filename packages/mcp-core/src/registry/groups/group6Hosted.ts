import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpActionId } from "@memorynodeai/shared";
import { z } from "zod";
import type { HostedBrandedDeps } from "../../adapters/hosted.js";
import { formatDeniedForTool, toolError } from "../../hosted/policyResponses.js";

export const USAGE_TODAY_DESCRIPTION = [
  "WHAT: Returns today’s usage counters and fair-use caps for the authenticated workspace.",
  "WHEN: Call this to inspect quota consumption, reads/writes/embeds, or billing-period context.",
  "INSTEAD: Use `billing_get` when you need subscription status rather than raw usage meters.",
  "RETURNS: JSON matching GET /v1/usage/today (caps, usage rows, operational mode).",
].join("\n");

export const AUDIT_LOG_LIST_DESCRIPTION = [
  "WHAT: Lists recent API audit entries for this workspace (routes, status, latency, key id hash).",
  "WHEN: Call this for compliance review, incident response, or verifying which keys called which routes.",
  "INSTEAD: Use console dashboards when you need charts; this tool is row-level audit trail only.",
  "RETURNS: Paginated `entries` plus page metadata per GET /v1/audit/log.",
].join("\n");

export const BILLING_GET_DESCRIPTION = [
  "WHAT: Returns billing subscription surface for the workspace (plan, status, period end when configured).",
  "WHEN: Call this before upgrades or to confirm whether billing webhooks are active in this environment.",
  "INSTEAD: Use `usage_today` for metered usage; billing_get is subscription metadata.",
  "RETURNS: JSON from GET /v1/billing/status or an error if billing is disabled/unconfigured.",
].join("\n");

export const BILLING_CHECKOUT_CREATE_DESCRIPTION = [
  "WHAT: Starts a PayU checkout for the workspace (returns POST form fields and payment URL per server config).",
  "WHEN: Call when the user wants to subscribe or change plan and you have confirmed plan and optional contact fields.",
  "INSTEAD: Use the MemoryNode billing UI when the user should not see raw payment form fields in the agent transcript.",
  "RETURNS: JSON from POST /v1/billing/checkout (`provider`, `method`, `url`, `fields`) or a billing-disabled / validation error.",
].join("\n");

export const BILLING_PORTAL_CREATE_DESCRIPTION = [
  "WHAT: Requests a self-serve billing portal session (legacy endpoint; platform may respond that the feature is deprecated).",
  "WHEN: Call only when the user explicitly asks for a billing management portal link and checkout is insufficient.",
  "INSTEAD: Use `billing_checkout_create` for PayU checkout; prefer the web app for subscription management when available.",
  "RETURNS: JSON from POST /v1/billing/portal — in current deployments often HTTP 410 with `GONE` when no portal integration is active.",
].join("\n");

function runPlanGate(deps: HostedBrandedDeps, tool: string) {
  const pg = deps.planGate;
  if (!pg) return null;
  const r = pg(tool, deps.auth);
  if (r.ok) return null;
  return toolError(r.code, r.message);
}

export function registerGroup6HostedTools(server: McpServer, deps: HostedBrandedDeps): void {
  const {
    env,
    restApiOrigin,
    apiKey,
    requestId,
    hostedPolicy,
    internalJson,
    MCP_POLICY_VERSION,
    resolveScope,
    toPolicyScope,
    evaluateWithLog,
  } = deps;

  server.registerTool(
    "usage_today",
    {
      description: USAGE_TODAY_DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      const execStart = Date.now();
      const gated = runPlanGate(deps, "usage_today");
      if (gated) return gated;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const actionId: McpActionId = "usage.today";
      const decision = evaluateWithLog(actionId, {
        scope,
        queryText: "usage_today",
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      try {
        const out = await internalJson(env, restApiOrigin, apiKey, "GET", "/v1/usage/today", undefined, requestId);
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Usage request failed";
          return toolError("cost_exceeded", msg);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out.data, null, 2) }],
          structuredContent: {
            status: "ok",
            data: out.data,
            policy_version: MCP_POLICY_VERSION,
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        hostedPolicy.complete({
          actionId,
          scope,
          nowMs: Date.now(),
          queryText: "usage_today",
        });
      }
    },
  );

  server.registerTool(
    "audit_log_list",
    {
      description: AUDIT_LOG_LIST_DESCRIPTION,
      inputSchema: {
        page: z.number().int().min(1).optional().default(1),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async ({ page, limit }) => {
      const execStart = Date.now();
      const gated = runPlanGate(deps, "audit_log_list");
      if (gated) return gated;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const actionId: McpActionId = "audit.log.list";
      const q = new URLSearchParams({ page: String(page), limit: String(limit) });
      const decision = evaluateWithLog(actionId, {
        scope,
        queryText: `audit:${q.toString()}`,
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      try {
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "GET",
          `/v1/audit/log?${q.toString()}`,
          undefined,
          requestId,
        );
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Audit log request failed";
          return toolError("cost_exceeded", msg);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out.data, null, 2) }],
          structuredContent: {
            status: "ok",
            data: out.data,
            policy_version: MCP_POLICY_VERSION,
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        hostedPolicy.complete({
          actionId,
          scope,
          nowMs: Date.now(),
          queryText: `audit_log_list:${q.toString()}`,
        });
      }
    },
  );

  server.registerTool(
    "billing_get",
    {
      description: BILLING_GET_DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      const execStart = Date.now();
      const gated = runPlanGate(deps, "billing_get");
      if (gated) return gated;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const actionId: McpActionId = "billing.status";
      const decision = evaluateWithLog(actionId, {
        scope,
        queryText: "billing_get",
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      try {
        const out = await internalJson(env, restApiOrigin, apiKey, "GET", "/v1/billing/status", undefined, requestId);
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Billing status request failed";
          return toolError("weak_signal", msg);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out.data, null, 2) }],
          structuredContent: {
            status: "ok",
            data: out.data,
            policy_version: MCP_POLICY_VERSION,
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        hostedPolicy.complete({
          actionId,
          scope,
          nowMs: Date.now(),
          queryText: "billing_get",
        });
      }
    },
  );

  server.registerTool(
    "billing_checkout_create",
    {
      description: BILLING_CHECKOUT_CREATE_DESCRIPTION,
      inputSchema: {
        plan: z.string().min(1).optional(),
        firstname: z.string().max(200).optional(),
        email: z.string().max(200).optional(),
        phone: z.string().max(40).optional(),
        nonce: z.string().min(8),
        timestampMs: z.number().int(),
      },
    },
    async (args) => {
      const execStart = Date.now();
      const gated = runPlanGate(deps, "billing_checkout_create");
      if (gated) return gated;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const body: Record<string, unknown> = {};
      if (args.plan !== undefined && args.plan !== "") body.plan = args.plan;
      if (args.firstname !== undefined) body.firstname = args.firstname;
      if (args.email !== undefined) body.email = args.email;
      if (args.phone !== undefined) body.phone = args.phone;
      const payloadText = JSON.stringify(body);
      const actionId: McpActionId = "billing.checkout.create";
      const decision = evaluateWithLog(actionId, {
        scope,
        queryText: "billing_checkout_create",
        contentText: payloadText,
        nonce: args.nonce,
        timestampMs: args.timestampMs,
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      const mustComplete = decision.status === "allow" || decision.status === "degrade";
      try {
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "POST",
          "/v1/billing/checkout",
          Object.keys(body).length > 0 ? body : {},
          requestId,
        );
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Billing checkout failed";
          return toolError("cost_exceeded", msg);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out.data, null, 2) }],
          structuredContent: {
            status: "ok",
            data: out.data,
            policy_version: MCP_POLICY_VERSION,
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        if (mustComplete) {
          hostedPolicy.complete({
            actionId,
            scope,
            nowMs: Date.now(),
            contentText: payloadText,
            nonce: args.nonce,
            timestampMs: args.timestampMs,
          });
        }
      }
    },
  );

  server.registerTool(
    "billing_portal_create",
    {
      description: BILLING_PORTAL_CREATE_DESCRIPTION,
      inputSchema: {
        nonce: z.string().min(8),
        timestampMs: z.number().int(),
      },
    },
    async (args) => {
      const execStart = Date.now();
      const gated = runPlanGate(deps, "billing_portal_create");
      if (gated) return gated;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const payloadText = "{}";
      const actionId: McpActionId = "billing.portal.create";
      const decision = evaluateWithLog(actionId, {
        scope,
        queryText: "billing_portal_create",
        contentText: payloadText,
        nonce: args.nonce,
        timestampMs: args.timestampMs,
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      const mustComplete = decision.status === "allow" || decision.status === "degrade";
      try {
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "POST",
          "/v1/billing/portal",
          {},
          requestId,
        );
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Billing portal request failed";
          return toolError("cost_exceeded", msg);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out.data, null, 2) }],
          structuredContent: {
            status: "ok",
            data: out.data,
            policy_version: MCP_POLICY_VERSION,
          },
        };
      } finally {
        hostedPolicy.recordExecution({
          actionId,
          decision: decision.status,
          reason: decision.reasonCode,
          latencyMs: Date.now() - execStart,
          sessionId: scope.sessionId,
          scores: { similarity: decision.loopConfidence, novelty: decision.noveltyScore },
        });
        if (mustComplete) {
          hostedPolicy.complete({
            actionId,
            scope,
            nowMs: Date.now(),
            contentText: payloadText,
            nonce: args.nonce,
            timestampMs: args.timestampMs,
          });
        }
      }
    },
  );
}
