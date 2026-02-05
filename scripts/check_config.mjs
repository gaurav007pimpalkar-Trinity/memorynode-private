#!/usr/bin/env node
/**
 * Production config guard.
 * - Reads env vars from process.env
 * - Stage resolution: CHECK_ENV takes precedence, otherwise ENVIRONMENT or NODE_ENV (prod/staging/dev).
 * - Fails fast for prod if required secrets/settings are missing or look like placeholders.
 * - Does not print secret values.
 */

const env = process.env;

function stageFromEnv() {
  const forced = (env.CHECK_ENV || "").toLowerCase();
  if (forced === "prod" || forced === "production") return "prod";
  const raw = (env.ENVIRONMENT || env.NODE_ENV || "dev").toLowerCase();
  if (raw === "prod" || raw === "production") return "prod";
  if (raw === "staging") return "staging";
  return "dev";
}

const stage = stageFromEnv();

const requiredForProd = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "API_KEY_SALT",
  "MASTER_ADMIN_TOKEN",
];

const placeholderPattern = /(changeme|xxxxx|placeholder|test)/i;

function isMissing(name) {
  const v = env[name];
  return v === undefined || v === null || `${v}`.trim() === "";
}

function isPlaceholder(name) {
  const v = env[name];
  if (v === undefined) return false;
  return placeholderPattern.test(`${v}`.trim());
}

const errors = [];

if (stage === "prod") {
  for (const key of requiredForProd) {
    if (isMissing(key)) errors.push(`${key} is required in production.`);
    else if (isPlaceholder(key)) errors.push(`${key} must not be a placeholder value.`);
  }

  const supabaseMode = (env.SUPABASE_MODE || "").toLowerCase();
  if (supabaseMode === "stub") {
    errors.push("SUPABASE_MODE=stub is forbidden in production.");
  }

  const embeddingsMode = (env.EMBEDDINGS_MODE || "").toLowerCase();
  if (!embeddingsMode) {
    errors.push("EMBEDDINGS_MODE is required in production.");
  }
  if (embeddingsMode === "openai") {
    if (isMissing("OPENAI_API_KEY")) {
      errors.push("OPENAI_API_KEY is required when EMBEDDINGS_MODE=openai.");
    } else if (isPlaceholder("OPENAI_API_KEY")) {
      errors.push("OPENAI_API_KEY must not be a placeholder value.");
    }
  }

  // Billing assumed on in prod
  for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
    if (isMissing(key)) errors.push(`${key} is required for billing in production.`);
    else if (isPlaceholder(key)) errors.push(`${key} must not be a placeholder value.`);
  }
} else {
  // Non-prod: keep lightweight, but hint how to run prod checks
  console.log(
    `Running in non-prod stage (${stage}). Set CHECK_ENV=production to enforce production requirements.`,
  );
}

if (errors.length > 0) {
  console.error("Config check failed:");
  for (const err of errors) console.error(`- ${err}`);
  process.exit(1);
}

console.log(`Config check passed for stage: ${stage}.`);
