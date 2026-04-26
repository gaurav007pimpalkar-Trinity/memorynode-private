import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { HandlerDeps } from "../router.js";
import type { AuthContext } from "../auth.js";
import { parseAllowedOrigins } from "../cors.js";
import { createRequestScopedSupabaseClient, createUserAccessTokenSupabaseClient } from "../dbClientFactory.js";
import { getDashboardSession, validateDashboardCsrf, verifySupabaseAccessToken, type DashboardSession } from "../dashboardSession.js";
import {
  DashboardBootstrapSchema,
  DashboardCreateApiKeySchema,
  DashboardCreateInviteSchema,
  DashboardCreateWorkspaceSchema,
  DashboardRemoveMemberSchema,
  DashboardRevokeApiKeySchema,
  DashboardRevokeInviteSchema,
  DashboardUpdateMemberRoleSchema,
  parseWithSchema,
} from "../contracts/index.js";

type DashboardErrorCode =
  | "auth_error"
  | "csrf_error"
  | "permission_denied"
  | "workspace_mismatch"
  | "validation_error"
  | "config_error"
  | "rpc_error";

type DashboardScopedClientFactory = (
  env: Env,
  auth: AuthContext,
) => Promise<SupabaseClient>;

type DashboardUserClientFactory = (
  env: Env,
  accessToken: string,
) => SupabaseClient;

export interface DashboardOpsHandlerDeps extends HandlerDeps {
  getDashboardSession: (
    request: Request,
    supabase: SupabaseClient,
  ) => Promise<DashboardSession | null>;
  validateDashboardCsrf: (
    request: Request,
    session: DashboardSession,
    originAllowlist: string[] | null,
  ) => void;
  parseAllowedOrigins: (raw: string | undefined) => string[] | null;
  createRequestScopedSupabaseClient: DashboardScopedClientFactory;
  createUserAccessTokenSupabaseClient: DashboardUserClientFactory;
  verifySupabaseAccessToken: (accessToken: string, env: Env) => Promise<{ userId: string } | null>;
}

function success(data: unknown): { ok: true; data: unknown } {
  return { ok: true, data };
}

function failure(
  code: DashboardErrorCode,
  message: string,
  details?: Record<string, unknown>,
): { ok: false; error: { code: DashboardErrorCode; message: string; details?: Record<string, unknown> } } {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function mapRpcStatus(errorMessage: string): number {
  const m = errorMessage.toLowerCase();
  if (
    m.includes("not authenticated")
    || m.includes("not authorized")
    || m.includes("only owners can")
    || m.includes("cannot remove last owner")
    || m.includes("seat cap reached")
  ) {
    return 403;
  }
  if (
    m.includes("invalid")
    || m.includes("required")
    || m.includes("not found")
  ) {
    return 400;
  }
  return 500;
}

function ensureScopedSessionConfig(env: Env): void {
  if (!env.SUPABASE_ANON_KEY || !env.SUPABASE_JWT_SECRET) {
    throw new Error("REQUEST_SCOPED_SESSION_UNAVAILABLE");
  }
}

async function requireDashboardSessionContext(
  request: Request,
  env: Env,
  serviceSupabase: SupabaseClient,
  deps: DashboardOpsHandlerDeps,
  requireCsrf: boolean,
): Promise<{ session: DashboardSession; scopedSupabase: SupabaseClient }> {
  const session = await deps.getDashboardSession(request, serviceSupabase);
  if (!session) {
    throw { status: 401, code: "auth_error", message: "Dashboard session is required" };
  }
  if (requireCsrf) {
    try {
      deps.validateDashboardCsrf(request, session, deps.parseAllowedOrigins(env.ALLOWED_ORIGINS));
    } catch (error) {
      const msg = (error as Error).message;
      if (msg === "ORIGIN_NOT_ALLOWED") {
        throw { status: 403, code: "permission_denied", message: "Origin not allowed" };
      }
      throw { status: 403, code: "csrf_error", message: "Invalid or missing CSRF token" };
    }
  }

  ensureScopedSessionConfig(env);
  const authCtx: AuthContext = {
    workspaceId: session.workspaceId,
    keyHash: `dashboard:${session.sessionId}`,
    apiKeyId: session.userId,
    plan: "pro",
    productPlan: "studio",
    planStatus: "past_due",
  };
  const scopedSupabase = await deps.createRequestScopedSupabaseClient(env, authCtx);
  return { session, scopedSupabase };
}

function ensureWorkspaceMatchesSession(requestWorkspaceId: string, sessionWorkspaceId: string): void {
  if (requestWorkspaceId !== sessionWorkspaceId) {
    throw { status: 403, code: "workspace_mismatch", message: "workspace_id must match active dashboard session workspace" };
  }
}

export function createDashboardOpsHandlers(
  requestDeps: DashboardOpsHandlerDeps,
  defaultDeps: DashboardOpsHandlerDeps,
): {
  handleDashboardBootstrap: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardListWorkspaces: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardCreateWorkspace: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardListApiKeys: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardCreateApiKey: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardRevokeApiKey: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardCreateInvite: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardRevokeInvite: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardUpdateMemberRole: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardRemoveMember: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardListMembers: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardListInvites: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    /**
     * Bootstrap flow (pre-session):
     * 1) Validate Supabase access token -> user identity
     * 2) Query user's latest workspace membership
     * 3) If found, return existing workspace
     * 4) If not found, call create_workspace RPC (owner membership created by SQL)
     * 5) Dashboard then establishes normal cookie session via /v1/dashboard/session
     */
    async handleDashboardBootstrap(request, env, _supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      const body = await parseWithSchema(DashboardBootstrapSchema, request);
      if (!body.ok) {
        return d.jsonResponse(failure("validation_error", body.error, body.details), 400);
      }
      const verified = await d.verifySupabaseAccessToken(body.data.access_token, env);
      if (!verified) {
        return d.jsonResponse(failure("auth_error", "Invalid or expired Supabase token"), 401);
      }
      const userSupabase = d.createUserAccessTokenSupabaseClient(env, body.data.access_token);
      const workspaces = await userSupabase
        .from("workspaces")
        .select("id, name, workspace_members!inner(user_id, created_at)")
        .eq("workspace_members.user_id", verified.userId)
        .limit(50);
      if (workspaces.error) {
        return d.jsonResponse(
          failure("rpc_error", workspaces.error.message ?? "Failed to query workspaces"),
          500,
        );
      }
      const existingRows = ((workspaces.data ?? []) as Array<{
        id?: string;
        name?: string | null;
        workspace_members?: Array<{ created_at?: string | null }> | null;
      }>)
        .map((row) => ({
          workspace_id: row.id ?? "",
          name: row.name ?? "Unnamed",
          created_at: row.workspace_members?.[0]?.created_at ?? null,
        }))
        .sort((a, b) => {
          const at = a.created_at ? Date.parse(a.created_at) : 0;
          const bt = b.created_at ? Date.parse(b.created_at) : 0;
          return bt - at;
        });
      const existing = existingRows[0];
      const existingWorkspaceId = existing?.workspace_id?.trim() ?? "";
      if (existingWorkspaceId) {
        return d.jsonResponse(
          success({
            workspace_id: existingWorkspaceId,
            name: existing.name ?? "Unnamed",
            created: false,
          }),
          200,
        );
      }

      const created = await userSupabase.rpc("create_workspace", {
        p_name: body.data.workspace_name ?? "My Project",
      });
      if (created.error) {
        return d.jsonResponse(
          failure("rpc_error", created.error.message ?? "Failed to bootstrap workspace"),
          mapRpcStatus(created.error.message ?? ""),
        );
      }
      const row = Array.isArray(created.data) ? created.data[0] : created.data;
      return d.jsonResponse(
        success({
          workspace_id: (row as { workspace_id?: string } | null)?.workspace_id ?? null,
          name: (row as { name?: string } | null)?.name ?? (body.data.workspace_name ?? "My Project"),
          created: true,
        }),
        200,
      );
    },

    async handleDashboardListWorkspaces(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { session, scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, false);
        const memberships = await scopedSupabase
          .from("workspaces")
          .select("id, name, workspace_members!inner(user_id, role, created_at)")
          .eq("workspace_members.user_id", session.userId)
          .limit(200);
        if (memberships.error) {
          return d.jsonResponse(
            failure("rpc_error", memberships.error.message ?? "Failed to list workspaces"),
            500,
          );
        }
        const workspaces = ((memberships.data ?? []) as Array<{
          id?: string;
          name?: string | null;
          workspace_members?: Array<{ role?: string | null; created_at?: string | null }> | null;
        }>)
          .map((row) => ({
            id: row.id ?? "",
            name: row.name ?? "Unnamed",
            role: row.workspace_members?.[0]?.role ?? "member",
            created_at: row.workspace_members?.[0]?.created_at ?? null,
          }))
          .sort((a, b) => {
            const at = a.created_at ? Date.parse(a.created_at) : 0;
            const bt = b.created_at ? Date.parse(b.created_at) : 0;
            return bt - at;
          })
          .map(({ id, name, role }) => ({ id, name, role }));
        return d.jsonResponse(success({ workspaces }), 200);
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },

    async handleDashboardCreateWorkspace(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, true);
        const body = await parseWithSchema(DashboardCreateWorkspaceSchema, request);
        if (!body.ok) {
          return d.jsonResponse(failure("validation_error", body.error, body.details), 400);
        }
        const { data, error } = await scopedSupabase.rpc("create_workspace", {
          p_name: body.data.name,
        });
        if (error) {
          return d.jsonResponse(
            failure("rpc_error", error.message ?? "Failed to create workspace"),
            mapRpcStatus(error.message ?? ""),
          );
        }
        const row = Array.isArray(data) ? data[0] : data;
        return d.jsonResponse(
          success({
            workspace_id: (row as { workspace_id?: string } | null)?.workspace_id ?? null,
            name: (row as { name?: string } | null)?.name ?? body.data.name,
          }),
          200,
        );
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },

    async handleDashboardListApiKeys(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { session, scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, false);
        const url = new URL(request.url);
        const workspaceId = (url.searchParams.get("workspace_id") ?? session.workspaceId).trim();
        ensureWorkspaceMatchesSession(workspaceId, session.workspaceId);
        const { data, error } = await scopedSupabase.rpc("list_api_keys", {
          p_workspace_id: workspaceId,
        });
        if (error) {
          return d.jsonResponse(
            failure("rpc_error", error.message ?? "Failed to list API keys"),
            mapRpcStatus(error.message ?? ""),
          );
        }
        return d.jsonResponse(success({ api_keys: (data as unknown[] | null) ?? [] }), 200);
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },

    async handleDashboardCreateApiKey(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { session, scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, true);
        const body = await parseWithSchema(DashboardCreateApiKeySchema, request);
        if (!body.ok) {
          return d.jsonResponse(failure("validation_error", body.error, body.details), 400);
        }
        ensureWorkspaceMatchesSession(body.data.workspace_id, session.workspaceId);
        const { data, error } = await scopedSupabase.rpc("create_api_key", {
          p_name: body.data.name,
          p_workspace_id: body.data.workspace_id,
        });
        if (error) {
          return d.jsonResponse(
            failure("rpc_error", error.message ?? "Failed to create API key"),
            mapRpcStatus(error.message ?? ""),
          );
        }
        const row = Array.isArray(data) ? data[0] : data;
        return d.jsonResponse(
          success({
            api_key_id: (row as { api_key_id?: string } | null)?.api_key_id ?? null,
            api_key: (row as { api_key?: string } | null)?.api_key ?? null,
            workspace_id: (row as { workspace_id?: string } | null)?.workspace_id ?? body.data.workspace_id,
            name: (row as { name?: string } | null)?.name ?? body.data.name,
            key_prefix: (row as { key_prefix?: string } | null)?.key_prefix ?? null,
            key_last4: (row as { key_last4?: string } | null)?.key_last4 ?? null,
          }),
          200,
        );
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },

    async handleDashboardRevokeApiKey(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, true);
        const body = await parseWithSchema(DashboardRevokeApiKeySchema, request);
        if (!body.ok) {
          return d.jsonResponse(failure("validation_error", body.error, body.details), 400);
        }
        const { data, error } = await scopedSupabase.rpc("revoke_api_key", {
          p_key_id: body.data.api_key_id,
        });
        if (error) {
          return d.jsonResponse(
            failure("rpc_error", error.message ?? "Failed to revoke API key"),
            mapRpcStatus(error.message ?? ""),
          );
        }
        const row = Array.isArray(data) ? data[0] : data;
        return d.jsonResponse(success({ revoked: Boolean((row as { revoked?: boolean } | null)?.revoked ?? true) }), 200);
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },

    async handleDashboardCreateInvite(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { session, scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, true);
        const body = await parseWithSchema(DashboardCreateInviteSchema, request);
        if (!body.ok) {
          return d.jsonResponse(failure("validation_error", body.error, body.details), 400);
        }
        ensureWorkspaceMatchesSession(body.data.workspace_id, session.workspaceId);
        const { data, error } = await scopedSupabase.rpc("create_invite", {
          p_workspace_id: body.data.workspace_id,
          p_email: body.data.email,
          p_role: body.data.role,
        });
        if (error) {
          return d.jsonResponse(
            failure("rpc_error", error.message ?? "Failed to create invite"),
            mapRpcStatus(error.message ?? ""),
          );
        }
        const row = Array.isArray(data) ? data[0] : data;
        return d.jsonResponse(
          success({
            id: (row as { id?: string } | null)?.id ?? null,
            workspace_id: (row as { workspace_id?: string } | null)?.workspace_id ?? body.data.workspace_id,
            email: (row as { email?: string } | null)?.email ?? body.data.email,
            role: (row as { role?: string } | null)?.role ?? body.data.role,
            expires_at: (row as { expires_at?: string } | null)?.expires_at ?? null,
          }),
          200,
        );
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },

    async handleDashboardRevokeInvite(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, true);
        const body = await parseWithSchema(DashboardRevokeInviteSchema, request);
        if (!body.ok) {
          return d.jsonResponse(failure("validation_error", body.error, body.details), 400);
        }
        const { data, error } = await scopedSupabase.rpc("revoke_invite", {
          p_invite_id: body.data.invite_id,
        });
        if (error) {
          return d.jsonResponse(
            failure("rpc_error", error.message ?? "Failed to revoke invite"),
            mapRpcStatus(error.message ?? ""),
          );
        }
        const row = Array.isArray(data) ? data[0] : data;
        return d.jsonResponse(success({ revoked: Boolean((row as { revoked?: boolean } | null)?.revoked ?? true) }), 200);
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },

    async handleDashboardUpdateMemberRole(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { session, scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, true);
        const body = await parseWithSchema(DashboardUpdateMemberRoleSchema, request);
        if (!body.ok) {
          return d.jsonResponse(failure("validation_error", body.error, body.details), 400);
        }
        ensureWorkspaceMatchesSession(body.data.workspace_id, session.workspaceId);
        const { data, error } = await scopedSupabase.rpc("update_member_role", {
          p_workspace_id: body.data.workspace_id,
          p_user_id: body.data.user_id,
          p_role: body.data.role,
        });
        if (error) {
          return d.jsonResponse(
            failure("rpc_error", error.message ?? "Failed to update member role"),
            mapRpcStatus(error.message ?? ""),
          );
        }
        const row = Array.isArray(data) ? data[0] : data;
        return d.jsonResponse(success({ updated: Boolean((row as { updated?: boolean } | null)?.updated ?? true) }), 200);
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },

    async handleDashboardRemoveMember(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { session, scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, true);
        const body = await parseWithSchema(DashboardRemoveMemberSchema, request);
        if (!body.ok) {
          return d.jsonResponse(failure("validation_error", body.error, body.details), 400);
        }
        ensureWorkspaceMatchesSession(body.data.workspace_id, session.workspaceId);
        const { data, error } = await scopedSupabase.rpc("remove_member", {
          p_workspace_id: body.data.workspace_id,
          p_user_id: body.data.user_id,
        });
        if (error) {
          return d.jsonResponse(
            failure("rpc_error", error.message ?? "Failed to remove member"),
            mapRpcStatus(error.message ?? ""),
          );
        }
        const row = Array.isArray(data) ? data[0] : data;
        return d.jsonResponse(success({ removed: Boolean((row as { removed?: boolean } | null)?.removed ?? true) }), 200);
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },

    async handleDashboardListMembers(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { session, scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, false);
        const url = new URL(request.url);
        const workspaceId = (url.searchParams.get("workspace_id") ?? session.workspaceId).trim();
        ensureWorkspaceMatchesSession(workspaceId, session.workspaceId);
        const members = await scopedSupabase
          .from("workspace_members")
          .select("user_id, role, created_at")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false });
        if (members.error) {
          return d.jsonResponse(
            failure("rpc_error", members.error.message ?? "Failed to list members"),
            500,
          );
        }
        return d.jsonResponse(success({ members: members.data ?? [] }), 200);
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },

    async handleDashboardListInvites(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as DashboardOpsHandlerDeps;
      try {
        const { session, scopedSupabase } = await requireDashboardSessionContext(request, env, supabase, d, false);
        const url = new URL(request.url);
        const workspaceId = (url.searchParams.get("workspace_id") ?? session.workspaceId).trim();
        ensureWorkspaceMatchesSession(workspaceId, session.workspaceId);
        const invites = await scopedSupabase
          .from("workspace_invites")
          .select("id, workspace_id, email, role, created_at, expires_at, accepted_at, revoked_at")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false });
        if (invites.error) {
          return d.jsonResponse(
            failure("rpc_error", invites.error.message ?? "Failed to list invites"),
            500,
          );
        }
        return d.jsonResponse(success({ invites: invites.data ?? [] }), 200);
      } catch (error) {
        if (typeof error === "object" && error !== null && "status" in error && "code" in error && "message" in error) {
          const e = error as { status: number; code: DashboardErrorCode; message: string };
          return d.jsonResponse(failure(e.code, e.message), e.status);
        }
        if ((error as Error).message === "REQUEST_SCOPED_SESSION_UNAVAILABLE") {
          return d.jsonResponse(
            failure("config_error", "Request-scoped session execution is unavailable"),
            500,
          );
        }
        return d.jsonResponse(failure("rpc_error", "Unexpected error"), 500);
      }
    },
  };
}

export const defaultDashboardOpsHandlerDeps: DashboardOpsHandlerDeps = {
  jsonResponse: (data: unknown, status = 200, extraHeaders?: Record<string, string>) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...(extraHeaders ?? {}) },
    }),
  getDashboardSession,
  validateDashboardCsrf,
  parseAllowedOrigins,
  createRequestScopedSupabaseClient,
  createUserAccessTokenSupabaseClient,
  verifySupabaseAccessToken,
};
