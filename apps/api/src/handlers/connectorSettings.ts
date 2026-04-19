import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { HandlerDeps } from "../router.js";
import { authenticate, rateLimit, rateLimitWorkspace } from "../auth.js";
import { getRouteRateLimitMax } from "../limits.js";
import {
  CAPTURE_TYPE_KEYS,
  ConnectorSettingPatchSchema,
  parseWithSchema,
  type ConnectorSettingPatchPayload,
} from "../contracts/index.js";

const DEFAULT_CAPTURE_TYPES: Record<string, boolean> = {
  pdf: true,
  docx: true,
  txt: true,
  md: true,
  html: true,
  csv: false,
  tsv: false,
  xlsx: false,
  pptx: false,
  eml: false,
  msg: false,
};

function normalizeCaptureTypes(input: unknown): Record<string, boolean> {
  const out = { ...DEFAULT_CAPTURE_TYPES };
  if (!input || typeof input !== "object") return out;
  const obj = input as Record<string, unknown>;
  for (const key of CAPTURE_TYPE_KEYS) {
    if (typeof obj[key] === "boolean") out[key] = obj[key] as boolean;
  }
  return out;
}

export interface ConnectorSettingsHandlerDeps extends HandlerDeps {}

export function createConnectorSettingsHandlers(
  requestDeps: ConnectorSettingsHandlerDeps,
  defaultDeps: ConnectorSettingsHandlerDeps,
): {
  handleGetConnectorSettings: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handlePatchConnectorSettings: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleGetConnectorSettings(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as ConnectorSettingsHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "default", auth.keyCreatedAt));
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      const wsRate = await rateLimitWorkspace(auth.workspaceId, 120, env);
      if (!wsRate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
          429,
          { ...rate.headers, ...wsRate.headers },
        );
      }
      const { data, error } = await supabase
        .from("connector_capture_settings")
        .select("connector_id,sync_enabled,capture_types,updated_at")
        .eq("workspace_id", auth.workspaceId)
        .order("updated_at", { ascending: false });
      if (error) {
        return jsonResponse({ error: { code: "DB_ERROR", message: error.message ?? "Failed to load settings" } }, 500);
      }
      const rows = (Array.isArray(data) ? data : []).map((row) => ({
        connector_id: typeof row.connector_id === "string" ? row.connector_id : "",
        sync_enabled: Boolean(row.sync_enabled ?? true),
        capture_types: normalizeCaptureTypes(row.capture_types),
        updated_at: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
      }));
      return jsonResponse({ settings: rows }, 200, { ...rate.headers, ...wsRate.headers });
    },

    async handlePatchConnectorSettings(request, env, supabase, auditCtx, deps?) {
      const d = (deps ?? defaultDeps) as ConnectorSettingsHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "default", auth.keyCreatedAt));
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      const wsRate = await rateLimitWorkspace(auth.workspaceId, 120, env);
      if (!wsRate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
          429,
          { ...rate.headers, ...wsRate.headers },
        );
      }
      const parseResult = await parseWithSchema(ConnectorSettingPatchSchema, request);
      if (!parseResult.ok) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: parseResult.error,
              ...(parseResult.details ? { details: parseResult.details } : {}),
            },
          },
          400,
        );
      }
      const payload = parseResult.data as ConnectorSettingPatchPayload;
      const captureTypes = normalizeCaptureTypes(payload.capture_types);
      const syncEnabled = payload.sync_enabled ?? true;
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("connector_capture_settings")
        .upsert(
          {
            workspace_id: auth.workspaceId,
            connector_id: payload.connector_id,
            sync_enabled: syncEnabled,
            capture_types: captureTypes,
            updated_at: now,
          },
          { onConflict: "workspace_id,connector_id" },
        );
      if (error) {
        return jsonResponse({ error: { code: "DB_ERROR", message: error.message ?? "Failed to save settings" } }, 500);
      }
      return jsonResponse(
        {
          connector_id: payload.connector_id,
          sync_enabled: syncEnabled,
          capture_types: captureTypes,
          updated_at: now,
        },
        200,
        { ...rate.headers, ...wsRate.headers },
      );
    },
  };
}
