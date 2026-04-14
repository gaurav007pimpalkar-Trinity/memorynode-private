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
  "SUPABASE_ANON_KEY",
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "API_KEY_SALT",
  "MASTER_ADMIN_TOKEN",
  "ALLOWED_ORIGINS",
  "SUPABASE_MODE",
  "EMBEDDINGS_MODE",
  "OPENAI_API_KEY",
  "BILLING_WEBHOOKS_ENABLED",
  "PAYU_MERCHANT_KEY",
  "PAYU_MERCHANT_SALT",
  "PAYU_WEBHOOK_SECRET",
  "PAYU_BASE_URL",
  "PAYU_VERIFY_URL",
  "PUBLIC_APP_URL",
  "PAYU_SUCCESS_PATH",
  "PAYU_CANCEL_PATH",
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
  SUPABASE_ANON_KEY: "anon_dummy_123",
  DATABASE_URL: "postgres://user:pass@db.internal:5432/memorynode?sslmode=require",
  API_KEY_SALT: "api_key_salt_123",
  MASTER_ADMIN_TOKEN: "admin_token_123",
  ALLOWED_ORIGINS: "https://console.memorynode.ai",
  EMBEDDINGS_MODE: "openai",
  OPENAI_API_KEY: "sk-test-1234567890",
  PAYU_MERCHANT_KEY: "payu_merchant_key_1234567890",
  PAYU_MERCHANT_SALT: "payu_merchant_salt_1234567890",
  PAYU_WEBHOOK_SECRET: "payu_webhook_secret_1234567890",
  PAYU_BASE_URL: "https://secure.payu.in",
  PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice?form=2",
  PUBLIC_APP_URL: "https://console.memorynode.ai",
  PAYU_SUCCESS_PATH: "/settings/billing?status=success",
  PAYU_CANCEL_PATH: "/settings/billing?status=canceled",
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

  it("fails in production when billing is enabled but PayU vars are missing", () => {
    const result = runCheckConfig({
      ...STRICT_BASE,
      PAYU_MERCHANT_SALT: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Missing PAYU_MERCHANT_SALT");
  });

  it("fails in production when ALLOWED_ORIGINS is missing", () => {
    const result = runCheckConfig({
      ...STRICT_BASE,
      ALLOWED_ORIGINS: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Missing ALLOWED_ORIGINS");
  });

  it("fails in production when SUPABASE_ANON_KEY is missing", () => {
    const result = runCheckConfig({
      ...STRICT_BASE,
      SUPABASE_ANON_KEY: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Missing SUPABASE_ANON_KEY");
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
