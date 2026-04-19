import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export type EnvironmentStage = "dev" | "staging" | "prod";
export type RateLimitMode = "on" | "off";

/** Single source of truth for Worker env. Used by index.ts and tests. */
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Optional: used to verify dashboard user JWT via Supabase Auth API (Get User). */
  SUPABASE_ANON_KEY?: string;
  /** Required for request-scoped JWT minting in rls-first mode. */
  SUPABASE_JWT_SECRET?: string;
  OPENAI_API_KEY: string;
  API_KEY_SALT: string;
  MASTER_ADMIN_TOKEN: string;
  AUTH_DEBUG?: string;
  EMBEDDINGS_MODE?: string;
  /** OpenAI embedding model id (default text-embedding-3-small). For text-embedding-3-large, worker sends dimensions=1536 to match pgvector(1536). */
  EMBEDDING_MODEL?: string;
  SUPABASE_MODE?: string;
  /** Access posture marker: service-role-only | rpc-first | rls-first. */
  SUPABASE_ACCESS_MODE?: string;
  /** Toggle request-scoped DB clients (0/1). */
  REQUEST_SCOPED_DB_ENABLED?: string;
  /** Hard kill-switch for service-role usage in request path (0/1). */
  DISABLE_SERVICE_ROLE_REQUEST_PATH?: string;
  ENVIRONMENT?: string;
  NODE_ENV?: string;
  BUILD_VERSION?: string;
  GIT_SHA?: string;
  RATE_LIMIT_DO: DurableObjectNamespace;
  /** Optional: shared circuit breaker state across isolates. When set, overrides in-memory per-isolate breaker. */
  CIRCUIT_BREAKER_DO?: DurableObjectNamespace;
  RATE_LIMIT_MODE?: string;
  /** Max requests per minute per key (default from limits.ts). New keys use 15 for 48h. */
  RATE_LIMIT_MAX?: string;
  RATE_LIMIT_SEARCH_MAX?: string;
  RATE_LIMIT_CONTEXT_MAX?: string;
  RATE_LIMIT_IMPORT_MAX?: string;
  RATE_LIMIT_BILLING_MAX?: string;
  RATE_LIMIT_ADMIN_MAX?: string;
  RATE_LIMIT_DASHBOARD_SESSION_MAX?: string;
  /** Active in-flight request cap per workspace (quota-consuming routes). */
  WORKSPACE_CONCURRENCY_MAX?: string;
  /** Lease TTL in ms for workspace in-flight slots. */
  WORKSPACE_CONCURRENCY_TTL_MS?: string;
  /** Optional INR burst guard (workspace estimated INR per 60s window). */
  WORKSPACE_COST_PER_MINUTE_CAP_INR?: string;
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
  /**
   * Base URL for REST calls from the MCP worker path (no trailing slash), e.g. https://api.memorynode.ai.
   * When unset, requests to mcp.memorynode.ai default to https://api.memorynode.ai; other hosts use the request origin.
   */
  MEMORYNODE_REST_ORIGIN?: string;
  /**
   * Shared secret for hosted MCP internal `fetch` subrequests to `/v1/*`. REST handlers skip duplicate edge rate
   * limits only when both `x-internal-mcp: true` and `x-internal-secret` match this value. Must be set in any
   * deployment that uses hosted MCP; keep out of client code. Unguessable random string (e.g. 32+ bytes hex).
   */
  MCP_INTERNAL_SECRET?: string;
  PAYU_SUCCESS_PATH?: string;
  PAYU_CANCEL_PATH?: string;
  PAYU_VERIFY_URL?: string;
  PAYU_VERIFY_TIMEOUT_MS?: string;
  PAYU_CURRENCY?: string;
  /** Global AI cost kill switch: max monthly estimated cost in INR (e.g. 50000). If exceeded, embedding/LLM calls return 503. */
  AI_COST_BUDGET_INR?: string;
  /** Optional: USD to INR rate for cost guard (default 83). */
  USD_TO_INR?: string;
  /** Optional safety multiplier applied to estimated per-request cost (default 1.35). */
  COST_DRIFT_MULTIPLIER?: string;
  /**
   * Optional fail-open override for AI cost guard ("1" enables fail-open on guard telemetry errors).
   * Production/staging should keep this unset so expensive AI routes fail closed when budget signal is unavailable.
   */
  AI_COST_GUARD_FAIL_OPEN?: string;
  /** Optional cap on active API keys per workspace (default 10). */
  MAX_ACTIVE_API_KEYS?: string;
  /** Admin auth mode: legacy (x-admin-token only) or signed-required (HMAC signed headers). */
  ADMIN_AUTH_MODE?: string;
  /** Break-glass toggle: when "1", allows legacy x-admin-token auth even in signed-required mode. */
  ADMIN_BREAK_GLASS?: string;
  /**
   * Optional comma-separated exact client IPs allowed to use `x-admin-token` routes.
   * Uses `cf-connecting-ip` or first `x-forwarded-for`. If unset, any IP is allowed (token-only auth).
   * Use in production to restrict admin API to bastion / CI egress IPs. `*` disables the check (emergency only).
   */
  ADMIN_ALLOWED_IPS?: string;
}

export function getEnvironmentStage(env: Env): EnvironmentStage {
  const raw = (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toString().toLowerCase();
  if (raw === "prod" || raw === "production") return "prod";
  if (raw === "staging") return "staging";
  return "dev";
}

const MIN_ADMIN_TOKEN_LENGTH = 24;
const MIN_API_KEY_SALT_LENGTH = 16;

export function validateSecrets(env: Env, stage: EnvironmentStage): string | null {
  if (stage === "dev") return null;
  const missing: string[] = [];
  const weak: string[] = [];
  const supabaseMode = (env.SUPABASE_MODE ?? "").toLowerCase();
  const embeddingsMode = (env.EMBEDDINGS_MODE ?? "openai").toLowerCase();

  if (supabaseMode !== "stub" && !env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  const accessMode = (env.SUPABASE_ACCESS_MODE ?? "rpc-first").toLowerCase();
  const scopedEnabled = (env.REQUEST_SCOPED_DB_ENABLED ?? "0").trim() === "1";
  const disableServiceRoleInRequestPath = (env.DISABLE_SERVICE_ROLE_REQUEST_PATH ?? "0").trim() === "1";
  if (
    supabaseMode !== "stub" &&
    (accessMode === "rls-first" || scopedEnabled || disableServiceRoleInRequestPath) &&
    !env.SUPABASE_ANON_KEY
  ) {
    missing.push("SUPABASE_ANON_KEY");
  }
  if (
    supabaseMode !== "stub" &&
    (accessMode === "rls-first" || scopedEnabled || disableServiceRoleInRequestPath) &&
    !env.SUPABASE_JWT_SECRET
  ) {
    missing.push("SUPABASE_JWT_SECRET");
  }
  if (!env.API_KEY_SALT) missing.push("API_KEY_SALT");
  if (!env.MASTER_ADMIN_TOKEN) missing.push("MASTER_ADMIN_TOKEN");
  if (embeddingsMode === "openai" && !env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (stage === "prod") {
    if (!env.AI_COST_BUDGET_INR || Number(env.AI_COST_BUDGET_INR) <= 0) {
      missing.push("AI_COST_BUDGET_INR");
    }
  }

  if (missing.length > 0) {
    return `Missing required secrets: ${missing.join(
      ", ",
    )}. Set each with ` + `wrangler secret put ${missing[0]}` + ` (repeat for the others) instead of wrangler.toml [vars].`;
  }

  if (env.MASTER_ADMIN_TOKEN && env.MASTER_ADMIN_TOKEN.length < MIN_ADMIN_TOKEN_LENGTH) {
    weak.push(`MASTER_ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters (current: ${env.MASTER_ADMIN_TOKEN.length})`);
  }
  if (env.API_KEY_SALT && env.API_KEY_SALT.length < MIN_API_KEY_SALT_LENGTH) {
    weak.push(`API_KEY_SALT must be at least ${MIN_API_KEY_SALT_LENGTH} characters (current: ${env.API_KEY_SALT.length})`);
  }

  if (weak.length > 0) {
    return `Weak secret configuration: ${weak.join("; ")}. Use cryptographically random values (e.g. openssl rand -hex 32).`;
  }

  return null;
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

export function isRlsFirstAccessMode(env: Env): boolean {
  const mode = (env.SUPABASE_ACCESS_MODE ?? "rpc-first").trim().toLowerCase();
  if (mode === "rls-first") return true;
  return (env.REQUEST_SCOPED_DB_ENABLED ?? "0").trim() === "1";
}

export function isServiceRoleRequestPathDisabled(env: Env): boolean {
  return (env.DISABLE_SERVICE_ROLE_REQUEST_PATH ?? "0").trim() === "1";
}

/** True when the Durable Object namespace is wired (Wrangler binding present). */
export function isRateLimitBindingPresent(env: Env): boolean {
  return Boolean(
    env.RATE_LIMIT_DO &&
      typeof (env.RATE_LIMIT_DO as { idFromName?: unknown }).idFromName === "function" &&
      typeof (env.RATE_LIMIT_DO as { get?: unknown }).get === "function",
  );
}

export function validateRateLimitConfig(env: Env, stage: EnvironmentStage): string | null {
  const mode = getRateLimitMode(env);
  if (mode === "off" && stage === "prod") {
    return "RATE_LIMIT_MODE=off is forbidden in production. Remove RATE_LIMIT_MODE or set it to 'on'.";
  }
  const hasBinding = isRateLimitBindingPresent(env);
  if (mode === "on" && !hasBinding) {
    return "Rate limiting is enabled but RATE_LIMIT_DO binding is missing. Add durable_objects binding { name = \"RATE_LIMIT_DO\", class_name = \"RateLimitDO\" } to wrangler.toml and apply the DO migration (tag v1).";
  }
  return null;
}
