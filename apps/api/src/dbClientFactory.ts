import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";
import { createHttpError } from "./http.js";
import { mintWorkspaceScopedJwt } from "./requestIdentity.js";
import type { AuthContext } from "./auth.js";

function createSupabaseClientWithKey(env: Env, apiKey: string, accessToken?: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, apiKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: accessToken
      ? {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      : undefined,
  });
}

export function createAnonSupabaseClient(env: Env): SupabaseClient {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw createHttpError(500, "CONFIG_ERROR", "SUPABASE_URL and SUPABASE_ANON_KEY must be configured");
  }
  return createSupabaseClientWithKey(env, env.SUPABASE_ANON_KEY);
}

export function createServiceRoleSupabaseClient(env: Env): SupabaseClient {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw createHttpError(500, "CONFIG_ERROR", "Supabase env vars not set");
  }
  return createSupabaseClientWithKey(env, env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function createRequestScopedSupabaseClient(env: Env, auth: AuthContext): Promise<SupabaseClient> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw createHttpError(500, "CONFIG_ERROR", "SUPABASE_URL and SUPABASE_ANON_KEY must be configured");
  }
  const subject = auth.apiKeyId && auth.apiKeyId.length > 0 ? auth.apiKeyId : crypto.randomUUID();
  const token = await mintWorkspaceScopedJwt(env, {
    workspaceId: auth.workspaceId,
    subject,
    scope: "request_path",
  });
  return createSupabaseClientWithKey(env, env.SUPABASE_ANON_KEY, token);
}
