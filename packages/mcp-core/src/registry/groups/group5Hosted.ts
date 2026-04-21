import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpActionId } from "@memorynodeai/shared";
import { z } from "zod";
import type { HostedBrandedDeps } from "../../adapters/hosted.js";
import { formatDeniedForTool, toolError } from "../../hosted/policyResponses.js";
import { trialExpiredWriteToolResult } from "../../hosted/trialWriteGate.js";

export const CONNECTOR_SETTINGS_GET_DESCRIPTION = [
  "WHAT: Returns connector capture settings for this workspace (per-connector sync flags and capture_types).",
  "WHEN: Call this before changing ingest behavior or when diagnosing why documents are not being captured.",
  "INSTEAD: Use `connector_settings_update` only when you need to change rows; reads are safer for inspection.",
  "RETURNS: JSON `{ settings: [...] }` from GET /v1/connectors/settings.",
].join("\n");

export const CONNECTOR_SETTINGS_UPDATE_DESCRIPTION = [
  "WHAT: Upserts one connector row (sync toggle and optional capture_types) for this workspace.",
  "WHEN: Call after the user confirms they want to enable/disable sync or change which file types are captured.",
  "INSTEAD: Use dashboard settings when you need UI validation; this tool mirrors PATCH /v1/connectors/settings.",
  "RETURNS: JSON confirming the upsert per PATCH /v1/connectors/settings.",
].join("\n");

/** Matches `ConnectorSettingPatchSchema` in apps/api connector settings contracts. */
const CaptureTypesSchema = z.object({
  pdf: z.boolean().optional(),
  docx: z.boolean().optional(),
  txt: z.boolean().optional(),
  md: z.boolean().optional(),
  html: z.boolean().optional(),
  csv: z.boolean().optional(),
  tsv: z.boolean().optional(),
  xlsx: z.boolean().optional(),
  pptx: z.boolean().optional(),
  eml: z.boolean().optional(),
  msg: z.boolean().optional(),
});

function runPlanGate(deps: HostedBrandedDeps, tool: string) {
  const pg = deps.planGate;
  if (!pg) return null;
  const r = pg(tool, deps.auth);
  if (r.ok) return null;
  return toolError(r.code, r.message);
}

export function registerGroup5HostedTools(server: McpServer, deps: HostedBrandedDeps): void {
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
    "connector_settings_get",
    {
      description: CONNECTOR_SETTINGS_GET_DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      const execStart = Date.now();
      const gated = runPlanGate(deps, "connector_settings_get");
      if (gated) return gated;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const actionId: McpActionId = "connector.settings.get";
      const decision = evaluateWithLog(actionId, {
        scope,
        queryText: "connector_settings_get",
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      try {
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "GET",
          "/v1/connectors/settings",
          undefined,
          requestId,
        );
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Connector settings request failed";
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
          queryText: "connector_settings_get",
        });
      }
    },
  );

  server.registerTool(
    "connector_settings_update",
    {
      description: CONNECTOR_SETTINGS_UPDATE_DESCRIPTION,
      inputSchema: {
        connector_id: z.string().min(1).max(120),
        sync_enabled: z.boolean().optional(),
        capture_types: CaptureTypesSchema.optional(),
        nonce: z.string().min(8),
        timestampMs: z.number().int(),
      },
    },
    async ({ connector_id, sync_enabled, capture_types, nonce, timestampMs }) => {
      const execStart = Date.now();
      const gated = runPlanGate(deps, "connector_settings_update");
      if (gated) return gated;
      const trialBlock = trialExpiredWriteToolResult(deps);
      if (trialBlock) return trialBlock;
      const { user_id, namespace } = resolveScope(null);
      const scope = toPolicyScope({ user_id, namespace });
      const body: Record<string, unknown> = { connector_id };
      if (sync_enabled !== undefined) body.sync_enabled = sync_enabled;
      if (capture_types !== undefined) body.capture_types = capture_types;
      const payloadText = JSON.stringify(body);
      const actionId: McpActionId = "connector.settings.update";
      const decision = evaluateWithLog(actionId, {
        scope,
        queryText: "connector_settings_update",
        contentText: payloadText,
        nonce,
        timestampMs,
      });
      if (decision.status === "deny") return formatDeniedForTool(actionId, scope, decision);
      try {
        const out = await internalJson(
          env,
          restApiOrigin,
          apiKey,
          "PATCH",
          "/v1/connectors/settings",
          body,
          requestId,
        );
        if (!out.ok) {
          const msg =
            typeof (out.data as { error?: { message?: string } })?.error?.message === "string"
              ? (out.data as { error: { message: string } }).error.message
              : "Connector settings update failed";
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
          contentText: payloadText,
          nonce,
          timestampMs,
        });
      }
    },
  );
}
