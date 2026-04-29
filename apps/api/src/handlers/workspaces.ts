/**
 * Workspace admin handler (create workspace). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * Dependencies injected via WorkspacesHandlerDeps to avoid circular dependency with index.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { Env } from "../env.js";
import type { HandlerDeps } from "../router.js";
import { getRouteRateLimitMax } from "../limits.js";
import { CreateWorkspaceSchema, parseWithSchema } from "../contracts/index.js";

export interface WorkspacesHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  requireAdmin: (request: Request, env: Env) => Promise<{ token: string }>;
  rateLimit: (
    keyHash: string,
    env: Env,
    auth?: { keyCreatedAt?: string | null },
    explicitLimit?: number,
  ) => Promise<{ allowed: boolean; headers: Record<string, string> }>;
  emitProductEvent: (
    supabase: SupabaseClient,
    eventName: string,
    ctx: Record<string, unknown>,
    props?: Record<string, unknown>,
  ) => Promise<void>;
}

export function createWorkspacesHandlers(
  requestDeps: WorkspacesHandlerDeps,
  defaultDeps: WorkspacesHandlerDeps,
): {
  handleCreateWorkspace: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleCreateWorkspace(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as WorkspacesHandlerDeps;
      const { jsonResponse } = d;
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:${token}`, env, undefined, getRouteRateLimitMax(env, "admin"));
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const body = await parseWithSchema(CreateWorkspaceSchema, request);
      if (!body.ok) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: body.error,
              ...(body.details ? { details: body.details } : {}),
            },
          },
          400,
          rate.headers,
        );
      }
      const internal = body.data.internal === true;
      const entitlementSource = body.data.entitlement_source ?? "billing";
      if (entitlementSource === "internal_grant" && !internal) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: "entitlement_source=internal_grant requires internal=true",
            },
          },
          400,
          rate.headers,
        );
      }

      const { data, error } = await supabase
        .from("workspaces")
        .insert({
          name: body.data.name,
          internal,
          entitlement_source: entitlementSource,
          internal_grant_enabled: entitlementSource === "internal_grant" && internal,
        })
        .select("id, name, internal, entitlement_source, internal_grant_enabled")
        .single();

      if (error || !data) {
        const rawMessage = error?.message ?? "Failed to create workspace";
        const hint =
          rawMessage.toLowerCase().includes("api key") || rawMessage.toLowerCase().includes("invalid")
            ? " Check Worker env: SUPABASE_SERVICE_ROLE_KEY must be the service_role key (not anon). SUPABASE_URL must match the same project."
            : "";
        return jsonResponse(
          {
            error: {
              code: "DB_ERROR",
              message: rawMessage + hint,
              ...(error?.code && { details: { supabase_code: error.code } }),
            },
          },
          500,
          rate.headers,
        );
      }

      const adminFingerprint =
        token === "<signed>"
          ? "admin:signed"
          : `admin:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;

      const auditInsert = await supabase.from("workspace_entitlement_audit").insert({
        workspace_id: data.id,
        changed_by: adminFingerprint,
        previous_source: null,
        new_source: data.entitlement_source ?? "billing",
        reason:
          body.data.grant_reason ??
          (data.entitlement_source === "internal_grant" ? "workspace_bootstrap_internal_grant" : "workspace_created"),
      });
      if (auditInsert.error) {
        void d.emitProductEvent(
          supabase,
          "workspace_entitlement_audit_insert_error",
          { workspaceId: data.id, route: "/v1/workspaces", method: "POST", status: 200 },
          { message: auditInsert.error.message ?? "unknown" },
        );
      }

      void d.emitProductEvent(
        supabase,
        "workspace_created",
        { workspaceId: data.id, route: "/v1/workspaces", method: "POST", status: 200 },
      );

      return jsonResponse(
        {
          workspace_id: data.id,
          name: data.name,
          internal: data.internal === true,
          entitlement_source: data.entitlement_source ?? "billing",
          internal_grant_enabled: data.internal_grant_enabled === true,
        },
        200,
        rate.headers,
      );
    },
  };
}
