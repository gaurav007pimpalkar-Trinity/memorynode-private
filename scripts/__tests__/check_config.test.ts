import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const checkConfigPath = path.join(repoRoot, "scripts", "check_config.mjs");

const RELEVANT_ENV_KEYS = [
  "CHECK_ENV",
  "DEPLOY_ENV",
  "ENVIRONMENT",
  "NODE_ENV",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "API_KEY_SALT",
  "MASTER_ADMIN_TOKEN",
  "SUPABASE_MODE",
  "EMBEDDINGS_MODE",
  "OPENAI_API_KEY",
  "BILLING_WEBHOOKS_ENABLED",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PUBLIC_APP_URL",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_TEAM",
];

function runCheckConfig(overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const key of RELEVANT_ENV_KEYS) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") env[key] = value;
  }

  const proc = spawnSync(process.execPath, [checkConfigPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });

  return {
    status: proc.status ?? 1,
    output: `${proc.stdout || ""}${proc.stderr || ""}`,
  };
}

const STRICT_BASE = {
  CHECK_ENV: "production",
  SUPABASE_URL: "https://memorynode.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "svrole_live_dummy_123",
  DATABASE_URL: "postgres://user:pass@db.internal:5432/memorynode?sslmode=require",
  API_KEY_SALT: "api_key_salt_123",
  MASTER_ADMIN_TOKEN: "admin_token_123",
  EMBEDDINGS_MODE: "openai",
  OPENAI_API_KEY: "sk-test-1234567890",
  STRIPE_SECRET_KEY: "stripe_secret_test_key_1234567890",
  STRIPE_WEBHOOK_SECRET: "stripe_webhook_secret_test_1234567890",
  PUBLIC_APP_URL: "https://app.memorynode.ai",
  STRIPE_PRICE_PRO: "price_pro_123",
  STRIPE_PRICE_TEAM: "price_team_123",
};

describe("check_config", () => {
  it("fails in production when core vars are missing", () => {
    const result = runCheckConfig({
      CHECK_ENV: "production",
      EMBEDDINGS_MODE: "stub",
      BILLING_WEBHOOKS_ENABLED: "0",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Missing SUPABASE_URL");
    expect(result.output).toContain("Missing SUPABASE_SERVICE_ROLE_KEY");
    expect(result.output).toContain("Missing one of SUPABASE_DB_URL or DATABASE_URL");
  });

  it("fails in staging when embeddings are openai but OPENAI_API_KEY is missing", () => {
    const result = runCheckConfig({
      ...STRICT_BASE,
      CHECK_ENV: "staging",
      OPENAI_API_KEY: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("OPENAI_API_KEY");
    expect(result.output).toContain("EMBEDDINGS_MODE=openai");
  });

  it("passes in canary when billing is explicitly disabled", () => {
    const result = runCheckConfig({
      ...STRICT_BASE,
      CHECK_ENV: "canary",
      EMBEDDINGS_MODE: "stub",
      OPENAI_API_KEY: undefined,
      BILLING_WEBHOOKS_ENABLED: "0",
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      PUBLIC_APP_URL: undefined,
      STRIPE_PRICE_PRO: undefined,
      STRIPE_PRICE_TEAM: undefined,
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("Billing checks skipped");
  });

  it("fails in production when billing is enabled but Stripe vars are missing", () => {
    const result = runCheckConfig({
      ...STRICT_BASE,
      STRIPE_WEBHOOK_SECRET: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Missing STRIPE_WEBHOOK_SECRET");
  });

  it("passes in production with strict requirements satisfied", () => {
    const result = runCheckConfig(STRICT_BASE);
    expect(result.status).toBe(0);
    expect(result.output).toContain("Config check passed");
  });

  it("passes in development with lightweight checks", () => {
    const result = runCheckConfig({
      CHECK_ENV: "development",
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("Non-strict mode");
  });
});
