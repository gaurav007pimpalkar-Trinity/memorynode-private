import { describe, expect, it } from "vitest";
import { mintWorkspaceScopedJwt } from "../src/requestIdentity.js";

describe("requestIdentity", () => {
  it("mints short-lived scoped jwt containing workspace claim", async () => {
    const token = await mintWorkspaceScopedJwt(
      {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service",
        SUPABASE_ANON_KEY: "anon",
        SUPABASE_JWT_SECRET: "very-secret-signing-key",
        OPENAI_API_KEY: "",
        API_KEY_SALT: "salt",
        MASTER_ADMIN_TOKEN: "token",
        RATE_LIMIT_DO: {
          idFromName: () => ({}) as never,
          get: () => ({ fetch: async () => new Response() }) as never,
        },
      },
      {
        workspaceId: "11111111-1111-1111-1111-111111111111",
        subject: "22222222-2222-2222-2222-222222222222",
        scope: "request_path",
      },
      60,
    );

    expect(token.split(".")).toHaveLength(3);
    const payloadRaw = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(payloadRaw));
    expect(payload.workspace_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(payload.scope).toBe("request_path");
    expect(payload.role).toBe("authenticated");
  });
});
