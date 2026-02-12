#!/usr/bin/env node
/**
 * Release/runtime config guard.
 * - Reads env vars from process.env
 * - Stage resolution: CHECK_ENV takes precedence, then DEPLOY_ENV, then ENVIRONMENT/NODE_ENV.
 * - Enforces strict requirements for staging/canary/production so release:gate fails early.
 * - Does not print secret values.
 */

const env = process.env;

const STRICT_STAGES = new Set(["staging", "canary", "production"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const placeholderPattern = /(changeme|replace_me|placeholder|xxxxx|<[^>]+>|your_[a-z0-9_]+|^tbd$|^todo$)/i;

function normalizeStage(raw) {
  const value = `${raw || ""}`.trim().toLowerCase();
  if (value === "prod" || value === "production") return "production";
  if (value === "staging") return "staging";
  if (value === "canary") return "canary";
  if (value === "dev" || value === "development" || value === "local" || value === "test") return "development";
  return "";
}

function stageFromEnv() {
  const candidates = [env.CHECK_ENV, env.DEPLOY_ENV, env.ENVIRONMENT, env.NODE_ENV];
  for (const candidate of candidates) {
    const normalized = normalizeStage(candidate);
    if (normalized) return normalized;
  }
  return "development";
}

function resolveCheckMode() {
  const raw = `${env.CHECK_CONFIG_MODE ?? ""}`.trim().toLowerCase();
  if (raw === "ci" || raw === "runtime") return raw;
  return env.CI ? "ci" : "runtime";
}

const stage = stageFromEnv();
const checkMode = resolveCheckMode();

function isMissing(name) {
  const v = env[name];
  return v === undefined || v === null || `${v}`.trim() === "";
}

function isPlaceholder(name) {
  const v = env[name];
  if (v === undefined || v === null) return false;
  return placeholderPattern.test(`${v}`.trim());
}

function requireVar(errors, key, why) {
  if (isMissing(key)) {
    errors.push(`[${stage}] Missing ${key}. ${why}`);
    return;
  }
  if (isPlaceholder(key)) {
    errors.push(`[${stage}] ${key} appears to be a placeholder. ${why}`);
  }
}

function requireOneOf(errors, keys, why) {
  const present = keys.filter((key) => !isMissing(key));
  if (present.length === 0) {
    errors.push(`[${stage}] Missing one of ${keys.join(" or ")}. ${why}`);
    return;
  }
  for (const key of present) {
    if (isPlaceholder(key)) {
      errors.push(`[${stage}] ${key} appears to be a placeholder. ${why}`);
    }
  }
}

function isBillingWebhooksEnabled() {
  const raw = `${env.BILLING_WEBHOOKS_ENABLED ?? "1"}`.trim().toLowerCase();
  return !FALSE_VALUES.has(raw);
}

function hasBillingConfigSignals() {
  const keys = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_PRO",
    "STRIPE_PRICE_TEAM",
    "PUBLIC_APP_URL",
    "STRIPE_PORTAL_CONFIGURATION_ID",
    "STRIPE_SUCCESS_PATH",
    "STRIPE_CANCEL_PATH",
  ];
  return keys.some((key) => !isMissing(key));
}

const errors = [];
const notes = [];
const strictStage = STRICT_STAGES.has(stage);
const embeddingsMode = `${env.EMBEDDINGS_MODE || ""}`.trim().toLowerCase();
const supabaseMode = `${env.SUPABASE_MODE || ""}`.trim().toLowerCase();
const rateLimitMode = `${env.RATE_LIMIT_MODE || "on"}`.trim().toLowerCase();
const billingWebhooksEnabled = isBillingWebhooksEnabled();
const billingRequired = strictStage && (billingWebhooksEnabled || hasBillingConfigSignals());

if (strictStage) {
  const commonContext =
    "Set this in your environment/CI (and as a Worker secret in Cloudflare for deployed environments).";
  requireVar(errors, "SUPABASE_URL", `${commonContext} Required for API database endpoint wiring.`);
  requireVar(
    errors,
    "SUPABASE_SERVICE_ROLE_KEY",
    `${commonContext} Required for Worker runtime Supabase access.`,
  );
  requireVar(errors, "API_KEY_SALT", `${commonContext} Required for API key hashing.`);
  requireVar(errors, "MASTER_ADMIN_TOKEN", `${commonContext} Required for admin endpoints.`);
  requireOneOf(
    errors,
    ["SUPABASE_DB_URL", "DATABASE_URL"],
    "Required by db:migrate, db:verify-rls, and db:verify-schema scripts (presence check only; no DB connection is attempted by check:config).",
  );

  if (!embeddingsMode) {
    errors.push(
      `[${stage}] Missing EMBEDDINGS_MODE. Set EMBEDDINGS_MODE=stub for local-safe mode or EMBEDDINGS_MODE=openai for real embeddings.`,
    );
  } else if (embeddingsMode === "openai") {
    requireVar(
      errors,
      "OPENAI_API_KEY",
      "Required when EMBEDDINGS_MODE=openai (embedding provider credential).",
    );
  } else if (embeddingsMode !== "stub") {
    errors.push(
      `[${stage}] Unsupported EMBEDDINGS_MODE="${embeddingsMode}". Supported modes: stub, openai. If this is intentional, extend scripts/check_config.mjs with provider-specific key checks.`,
    );
  }

  if (billingRequired) {
    const billingContext = `Billing is considered enabled in ${stage} (BILLING_WEBHOOKS_ENABLED=${billingWebhooksEnabled ? "1" : "0"}).`;
    requireVar(errors, "STRIPE_SECRET_KEY", `${billingContext} Required for billing endpoints.`);
    requireVar(errors, "STRIPE_WEBHOOK_SECRET", `${billingContext} Required for webhook signature verification.`);
    requireVar(errors, "PUBLIC_APP_URL", `${billingContext} Required to generate checkout/portal URLs.`);
    requireVar(errors, "STRIPE_PRICE_PRO", `${billingContext} Required for Pro checkout plan.`);
    requireVar(errors, "STRIPE_PRICE_TEAM", `${billingContext} Required for Team checkout plan.`);
  } else {
    notes.push(
      `[${stage}] Billing checks skipped because BILLING_WEBHOOKS_ENABLED=0 and no Stripe billing config signals were provided.`,
    );
  }

  if (stage === "production") {
    if (supabaseMode === "stub") {
      errors.push(
        "[production] SUPABASE_MODE=stub is forbidden. Use a real Supabase project URL + service role key.",
      );
    }
    if (embeddingsMode === "stub") {
      errors.push("[production] EMBEDDINGS_MODE=stub is forbidden. Use EMBEDDINGS_MODE=openai in production.");
    }
    if (FALSE_VALUES.has(rateLimitMode)) {
      errors.push("[production] RATE_LIMIT_MODE=off is forbidden. Remove RATE_LIMIT_MODE or set it to 'on'.");
    }
  }
  if (checkMode === "ci") {
    notes.push(
      `[${stage}] check_mode=ci validates env presence and placeholder protection only; network connectivity is validated by deploy/smoke steps, not release:gate.`,
    );
  }
} else {
  notes.push(
    `[${stage}] Non-strict mode: set CHECK_ENV=staging|canary|production to enforce release-grade requirements.`,
  );
}

if (errors.length > 0) {
  console.error(
    `Config check failed for stage=${stage}; mode=${checkMode}; EMBEDDINGS_MODE=${embeddingsMode || "(unset)"}; BILLING_WEBHOOKS_ENABLED=${billingWebhooksEnabled ? "1" : "0"}:`,
  );
  for (const err of errors) console.error(`- ${err}`);
  if (notes.length > 0) {
    console.error("Notes:");
    for (const note of notes) console.error(`- ${note}`);
  }
  process.exit(1);
}

console.log(
  `Config check passed for stage=${stage}; mode=${checkMode}; EMBEDDINGS_MODE=${embeddingsMode || "(unset)"}; BILLING_WEBHOOKS_ENABLED=${billingWebhooksEnabled ? "1" : "0"}.`,
);
for (const note of notes) console.log(`Note: ${note}`);
