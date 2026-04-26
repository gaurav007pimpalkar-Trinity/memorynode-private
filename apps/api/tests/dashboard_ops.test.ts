import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDashboardOpsHandlers, type DashboardOpsHandlerDeps } from "../src/handlers/dashboardOps.js";
import type { DashboardSession } from "../src/dashboardSession.js";

const SESSION: DashboardSession = {
  userId: "user-1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "sess-1",
  csrfToken: "csrf-token",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function makeEnv(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    ALLOWED_ORIGINS: "https://console.memorynode.ai",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_JWT_SECRET: "jwt",
    ...overrides,
  };
}

function makeDeps(options?: {
  session?: DashboardSession | null;
  csrfThrows?: boolean;
  rpcImpl?: (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  fromImpl?: (
    table: string,
    op: "scoped" | "user",
  ) => {
    data: unknown;
    error: { message: string } | null;
  };
  verifyResult?: { userId: string } | null;
}) {
  const rpcSpy = vi.fn(options?.rpcImpl ?? (async () => ({ data: null, error: null })));
  const defaultFrom = (_table: string, _op: "scoped" | "user") => ({ data: [], error: null });
  const fromFactory = options?.fromImpl ?? defaultFrom;
  const sessionValue = options && "session" in options ? options.session : SESSION;
  const verifyValue = options && "verifyResult" in options ? options.verifyResult : { userId: SESSION.userId };
  const deps: DashboardOpsHandlerDeps = {
    jsonResponse,
    getDashboardSession: vi.fn(async () => sessionValue ?? null),
    validateDashboardCsrf: vi.fn(() => {
      if (options?.csrfThrows) throw new Error("CSRF_TOKEN_INVALID");
    }),
    parseAllowedOrigins: vi.fn(() => ["https://console.memorynode.ai"]),
    createRequestScopedSupabaseClient: vi.fn(async () => ({
      rpc: rpcSpy,
      from: (table: string) => {
        const result = fromFactory(table, "scoped");
        const builder = {
          data: result.data,
          error: result.error,
          select: () => builder,
          eq: () => builder,
          order: () => builder,
          limit: () => builder,
        };
        return builder;
      },
    } as unknown as SupabaseClient)),
    createUserAccessTokenSupabaseClient: vi.fn(() => ({
      rpc: rpcSpy,
      from: (table: string) => {
        const result = fromFactory(table, "user");
        const builder = {
          data: result.data,
          error: result.error,
          select: () => builder,
          eq: () => builder,
          order: () => builder,
          limit: () => builder,
        };
        return builder;
      },
    } as unknown as SupabaseClient)),
    verifySupabaseAccessToken: vi.fn(async () => verifyValue),
  };
  return { deps, rpcSpy };
}

async function getJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("dashboard ops api keys (phase order step 1)", () => {
  it("GET /dashboard/api-keys requires dashboard session", async () => {
    const { deps } = makeDeps({ session: null });
    const handlers = createDashboardOpsHandlers(deps, deps);
    const res = await handlers.handleDashboardListApiKeys(
      new Request("http://localhost/v1/dashboard/api-keys"),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(res.status).toBe(401);
    const body = await getJson(res);
    expect(body.ok).toBe(false);
    expect((body.error as { code: string }).code).toBe("auth_error");
  });

  it("POST /dashboard/api-keys enforces CSRF", async () => {
    const { deps } = makeDeps({ csrfThrows: true });
    const handlers = createDashboardOpsHandlers(deps, deps);
    const res = await handlers.handleDashboardCreateApiKey(
      new Request("http://localhost/v1/dashboard/api-keys", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: SESSION.workspaceId,
          name: "Prod key",
        }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(res.status).toBe(403);
    const body = await getJson(res);
    expect((body.error as { code: string }).code).toBe("csrf_error");
  });

  it("POST /dashboard/api-keys rejects workspace mismatch", async () => {
    const { deps } = makeDeps();
    const handlers = createDashboardOpsHandlers(deps, deps);
    const res = await handlers.handleDashboardCreateApiKey(
      new Request("http://localhost/v1/dashboard/api-keys", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: "22222222-2222-4222-8222-222222222222",
          name: "Prod key",
        }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(res.status).toBe(403);
    const body = await getJson(res);
    expect((body.error as { code: string }).code).toBe("workspace_mismatch");
  });

  it("proxies create/list/revoke api-key RPCs successfully", async () => {
    const { deps, rpcSpy } = makeDeps({
      rpcImpl: async (name, args) => {
        if (name === "create_api_key") {
          expect(args).toEqual({
            p_name: "Prod key",
            p_workspace_id: SESSION.workspaceId,
          });
          return {
            data: [{ api_key_id: "k1", api_key: "mn_live_plain", workspace_id: SESSION.workspaceId, name: "Prod key" }],
            error: null,
          };
        }
        if (name === "list_api_keys") {
          expect(args).toEqual({ p_workspace_id: SESSION.workspaceId });
          return { data: [{ id: "k1", name: "Prod key" }], error: null };
        }
        if (name === "revoke_api_key") {
          expect(args).toEqual({ p_key_id: "66666666-6666-4666-8666-666666666666" });
          return { data: [{ revoked: true }], error: null };
        }
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      },
    });
    const handlers = createDashboardOpsHandlers(deps, deps);

    const createRes = await handlers.handleDashboardCreateApiKey(
      new Request("http://localhost/v1/dashboard/api-keys", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: SESSION.workspaceId,
          name: "Prod key",
        }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(createRes.status).toBe(200);
    const createBody = await getJson(createRes);
    expect(createBody.ok).toBe(true);

    const listRes = await handlers.handleDashboardListApiKeys(
      new Request(`http://localhost/v1/dashboard/api-keys?workspace_id=${SESSION.workspaceId}`),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(listRes.status).toBe(200);

    const revokeRes = await handlers.handleDashboardRevokeApiKey(
      new Request("http://localhost/v1/dashboard/api-keys/revoke", {
        method: "POST",
        body: JSON.stringify({ api_key_id: "66666666-6666-4666-8666-666666666666" }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(revokeRes.status).toBe(200);
    expect(rpcSpy).toHaveBeenCalledTimes(3);
  });
});

describe("dashboard bootstrap (phase 3.1)", () => {
  it("rejects unauthorized bootstrap token", async () => {
    const { deps } = makeDeps({ verifyResult: null });
    const handlers = createDashboardOpsHandlers(deps, deps);
    const res = await handlers.handleDashboardBootstrap(
      new Request("http://localhost/v1/dashboard/bootstrap", {
        method: "POST",
        body: JSON.stringify({ access_token: "bad" }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(res.status).toBe(401);
    const body = await getJson(res);
    expect((body.error as { code: string }).code).toBe("auth_error");
  });

  it("returns existing workspace for already-onboarded user", async () => {
    const { deps, rpcSpy } = makeDeps({
      fromImpl: (table, op) => {
        if (op === "user" && table === "workspace_members") {
          return {
            data: [{ workspace_id: SESSION.workspaceId, workspaces: { name: "Existing" } }],
            error: null,
          };
        }
        return { data: [], error: null };
      },
    });
    const handlers = createDashboardOpsHandlers(deps, deps);
    const res = await handlers.handleDashboardBootstrap(
      new Request("http://localhost/v1/dashboard/bootstrap", {
        method: "POST",
        body: JSON.stringify({ access_token: "good" }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect((body.data as { created: boolean }).created).toBe(false);
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("creates first workspace for new user", async () => {
    const { deps } = makeDeps({
      rpcImpl: async (name, args) => {
        expect(name).toBe("create_workspace");
        expect(args).toEqual({ p_name: "My Project" });
        return {
          data: [{ workspace_id: "99999999-9999-4999-8999-999999999999", name: "My Project" }],
          error: null,
        };
      },
      fromImpl: (table, op) => {
        if (op === "user" && table === "workspace_members") {
          return { data: [], error: null };
        }
        return { data: [], error: null };
      },
    });
    const handlers = createDashboardOpsHandlers(deps, deps);
    const res = await handlers.handleDashboardBootstrap(
      new Request("http://localhost/v1/dashboard/bootstrap", {
        method: "POST",
        body: JSON.stringify({ access_token: "good", workspace_name: "My Project" }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect((body.data as { created: boolean }).created).toBe(true);
  });
});

describe("dashboard ops workspaces (phase order step 2)", () => {
  it("requires auth + csrf + successful RPC proxy", async () => {
    const { deps } = makeDeps({
      rpcImpl: async (name, args) => {
        expect(name).toBe("create_workspace");
        expect(args).toEqual({ p_name: "My Project" });
        return { data: [{ workspace_id: "33333333-3333-4333-8333-333333333333", name: "My Project" }], error: null };
      },
    });
    const handlers = createDashboardOpsHandlers(deps, deps);
    const res = await handlers.handleDashboardCreateWorkspace(
      new Request("http://localhost/v1/dashboard/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "My Project" }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.ok).toBe(true);
    expect((body.data as { workspace_id: string }).workspace_id).toBe("33333333-3333-4333-8333-333333333333");
  });
});

describe("dashboard ops invites + members (phase order step 3)", () => {
  it("create_invite enforces workspace match and proxies RPC", async () => {
    const { deps } = makeDeps({
      rpcImpl: async (name, args) => {
        expect(name).toBe("create_invite");
        expect(args).toEqual({
          p_workspace_id: SESSION.workspaceId,
          p_email: "user@example.com",
          p_role: "member",
        });
        return {
          data: [{
            id: "44444444-4444-4444-8444-444444444444",
            workspace_id: SESSION.workspaceId,
            email: "user@example.com",
            role: "member",
          }],
          error: null,
        };
      },
    });
    const handlers = createDashboardOpsHandlers(deps, deps);
    const res = await handlers.handleDashboardCreateInvite(
      new Request("http://localhost/v1/dashboard/invites", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: SESSION.workspaceId,
          email: "user@example.com",
          role: "member",
        }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(res.status).toBe(200);
  });

  it("revoke_invite, update_member_role, remove_member proxy RPCs", async () => {
    const { deps, rpcSpy } = makeDeps({
      rpcImpl: async (name, args) => {
        if (name === "revoke_invite") return { data: [{ revoked: true }], error: null };
        if (name === "update_member_role") {
          expect(args).toEqual({
            p_workspace_id: SESSION.workspaceId,
            p_user_id: "55555555-5555-4555-8555-555555555555",
            p_role: "admin",
          });
          return { data: [{ updated: true }], error: null };
        }
        if (name === "remove_member") {
          expect(args).toEqual({
            p_workspace_id: SESSION.workspaceId,
            p_user_id: "55555555-5555-4555-8555-555555555555",
          });
          return { data: [{ removed: true }], error: null };
        }
        return { data: null, error: { message: `unexpected ${name}` } };
      },
    });
    const handlers = createDashboardOpsHandlers(deps, deps);

    const revokeRes = await handlers.handleDashboardRevokeInvite(
      new Request("http://localhost/v1/dashboard/invites/revoke", {
        method: "POST",
        body: JSON.stringify({ invite_id: "44444444-4444-4444-8444-444444444444" }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(revokeRes.status).toBe(200);

    const roleRes = await handlers.handleDashboardUpdateMemberRole(
      new Request("http://localhost/v1/dashboard/members/role", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: SESSION.workspaceId,
          user_id: "55555555-5555-4555-8555-555555555555",
          role: "admin",
        }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(roleRes.status).toBe(200);

    const removeRes = await handlers.handleDashboardRemoveMember(
      new Request("http://localhost/v1/dashboard/members/remove", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: SESSION.workspaceId,
          user_id: "55555555-5555-4555-8555-555555555555",
        }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(removeRes.status).toBe(200);
    expect(rpcSpy).toHaveBeenCalledTimes(3);
  });

  it("members role/remove reject workspace mismatch", async () => {
    const { deps } = makeDeps();
    const handlers = createDashboardOpsHandlers(deps, deps);
    const roleRes = await handlers.handleDashboardUpdateMemberRole(
      new Request("http://localhost/v1/dashboard/members/role", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: "22222222-2222-4222-8222-222222222222",
          user_id: "55555555-5555-4555-8555-555555555555",
          role: "admin",
        }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(roleRes.status).toBe(403);
    const roleBody = await getJson(roleRes);
    expect((roleBody.error as { code: string }).code).toBe("workspace_mismatch");

    const removeRes = await handlers.handleDashboardRemoveMember(
      new Request("http://localhost/v1/dashboard/members/remove", {
        method: "POST",
        body: JSON.stringify({
          workspace_id: "22222222-2222-4222-8222-222222222222",
          user_id: "55555555-5555-4555-8555-555555555555",
        }),
      }),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(removeRes.status).toBe(403);
  });

  it("list workspaces/members/invites via dashboard endpoints", async () => {
    const { deps } = makeDeps({
      fromImpl: (table, op) => {
        if (op === "scoped" && table === "workspace_members") {
          return {
            data: [{ user_id: "u1", role: "owner", created_at: "2026-01-01T00:00:00Z" }],
            error: null,
          };
        }
        if (op === "scoped" && table === "workspace_invites") {
          return {
            data: [{ id: "i1", workspace_id: SESSION.workspaceId, email: "x@y.com", role: "member" }],
            error: null,
          };
        }
        return { data: [], error: null };
      },
    });
    const handlers = createDashboardOpsHandlers(deps, deps);

    const wsRes = await handlers.handleDashboardListWorkspaces(
      new Request("http://localhost/v1/dashboard/workspaces"),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(wsRes.status).toBe(200);

    const mRes = await handlers.handleDashboardListMembers(
      new Request(`http://localhost/v1/dashboard/members?workspace_id=${SESSION.workspaceId}`),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(mRes.status).toBe(200);

    const iRes = await handlers.handleDashboardListInvites(
      new Request(`http://localhost/v1/dashboard/invites?workspace_id=${SESSION.workspaceId}`),
      makeEnv() as never,
      {} as SupabaseClient,
    );
    expect(iRes.status).toBe(200);
  });
});
