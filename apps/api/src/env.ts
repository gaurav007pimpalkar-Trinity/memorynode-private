import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export type EnvironmentStage = "dev" | "staging" | "prod";
export type RateLimitMode = "on" | "off";

/** Single source of truth for Worker env. Used by index.ts and tests. */
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Optional: used to verify dashboard user JWT via Supabase Auth API (Get User). */
  SUPABASE_ANON_KEY?: string;
  OPENAI_API_KEY: string;
  API_KEY_SALT: string;
  MASTER_ADMIN_TOKEN: string;
  AUTH_DEBUG?: string;
  EMBEDDINGS_MODE?: string;
  SUPABASE_MODE?: string;
  ENVIRONMENT?: string;
  NODE_ENV?: string;
  BUILD_VERSION?: string;
  GIT_SHA?: string;
  RATE_LIMIT_DO: DurableObjectNamespace;
  RATE_LIMIT_MODE?: string;
  ALLOWED_ORIGINS?: string;
  MAX_BODY_BYTES?: string;
  AUDIT_IP_SALT?: string;
  MAX_IMPORT_BYTES?: string;
  MAX_EXPORT_BYTES?: string;
  PAYU_MERCHANT_KEY?: string;
  PAYU_MERCHANT_SALT?: string;
  PAYU_WEBHOOK_SECRET?: string;
  BILLING_RECONCILE_ON_AMBIGUITY?: string;
  BILLING_WEBHOOKS_ENABLED?: string;
  PAYU_BASE_URL?: string;
  /** Per-plan amounts (preferred). Fallback: PAYU_PRO_AMOUNT for backward compat. */
  PAYU_LAUNCH_AMOUNT?: string;
  PAYU_BUILD_AMOUNT?: string;
  PAYU_DEPLOY_AMOUNT?: string;
  PAYU_SCALE_AMOUNT?: string;
  PAYU_PRO_AMOUNT?: string;
  PAYU_PRODUCT_INFO?: string;
  PUBLIC_APP_URL?: string;
  PAYU_SUCCESS_PATH?: string;
  PAYU_CANCEL_PATH?: string;
  PAYU_VERIFY_URL?: string;
  PAYU_VERIFY_TIMEOUT_MS?: string;
  PAYU_CURRENCY?: string;
}

export function getEnvironmentStage(env: Env): EnvironmentStage {
  const raw = (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toString().toLowerCase();
  if (raw === "prod" || raw === "production") return "prod";
  if (raw === "staging") return "staging";
  return "dev";
}

export function validateSecrets(env: Env, stage: EnvironmentStage): string | null {
  if (stage === "dev") return null;
  const missing: string[] = [];
  const supabaseMode = (env.SUPABASE_MODE ?? "").toLowerCase();
  const embeddingsMode = (env.EMBEDDINGS_MODE ?? "openai").toLowerCase();

  if (supabaseMode !== "stub" && !env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!env.API_KEY_SALT) missing.push("API_KEY_SALT");
  if (!env.MASTER_ADMIN_TOKEN) missing.push("MASTER_ADMIN_TOKEN");
  if (embeddingsMode === "openai" && !env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (missing.length === 0) return null;
  return `Missing required secrets: ${missing.join(
    ", ",
  )}. Set each with ` + `wrangler secret put ${missing[0]}` + ` (repeat for the others) instead of wrangler.toml [vars].`;
}

export function validateStubModes(env: Env, stage: EnvironmentStage): string | null {
  if (stage !== "prod") return null;
  const issues: string[] = [];
  if ((env.SUPABASE_MODE ?? "").toLowerCase() === "stub") issues.push("SUPABASE_MODE=stub");
  if ((env.EMBEDDINGS_MODE ?? "openai").toLowerCase() === "stub") issues.push("EMBEDDINGS_MODE=stub");
  if (issues.length === 0) return null;
  return `Stub modes are disallowed in production. Disable: ${issues.join(
    ", ",
  )}. Set SUPABASE_MODE to your real Supabase connection and EMBEDDINGS_MODE=openai.`;
}

export function getRateLimitMode(env: Env): RateLimitMode {
  return (env.RATE_LIMIT_MODE ?? "on").toLowerCase() === "off" ? "off" : "on";
}

export function validateRateLimitConfig(env: Env, stage: EnvironmentStage): string | null {
  const mode = getRateLimitMode(env);
  if (mode === "off" && stage === "prod") {
    return "RATE_LIMIT_MODE=off is forbidden in production. Remove RATE_LIMIT_MODE or set it to 'on'.";
  }
  const hasBinding =
    env.RATE_LIMIT_DO && typeof (env.RATE_LIMIT_DO as { idFromName?: unknown }).idFromName === "function" &&
    typeof (env.RATE_LIMIT_DO as { get?: unknown }).get === "function";
  if (mode === "on" && !hasBinding) {
    return "Rate limiting is enabled but RATE_LIMIT_DO binding is missing. Add durable_objects binding { name = \"RATE_LIMIT_DO\", class_name = \"RateLimitDO\" } to wrangler.toml and apply the DO migration (tag v1).";
  }
  return null;
}
