/**
 * Shared test environment factory.
 * Provides a typed, reusable `makeTestEnv()` that covers all required + optional env vars
 * with safe defaults so tests don't need to repeat boilerplate.
 *
 * Phase 7: typed mocks.
 */

import { makeRateLimitDoStub } from "./rate_limit_do.js";

/** Minimal env shape tests need. Matches the real Env interface without importing Worker types. */
export interface TestEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENAI_API_KEY: string;
  API_KEY_SALT: string;
  MASTER_ADMIN_TOKEN: string;
  EMBEDDINGS_MODE?: string;
  SUPABASE_MODE?: string;
  ENVIRONMENT?: string;
  RATE_LIMIT_DO: ReturnType<typeof makeRateLimitDoStub>;
  RATE_LIMIT_MODE?: string;
  ALLOWED_ORIGINS?: string;
  PAYU_MERCHANT_KEY?: string;
  PAYU_MERCHANT_SALT?: string;
  PAYU_BASE_URL?: string;
  PAYU_VERIFY_URL?: string;
  PAYU_CURRENCY?: string;
  PAYU_PRO_AMOUNT?: string;
  PAYU_PRODUCT_INFO?: string;
  PUBLIC_APP_URL?: string;
  BILLING_WEBHOOKS_ENABLED?: string;
  BILLING_RECONCILE_ON_AMBIGUITY?: string;
  [key: string]: unknown;
}

/**
 * Create a test env with safe defaults. Override any field via `overrides`.
 *
 * Usage:
 * ```ts
 * const env = makeTestEnv(); // defaults (stub mode, no billing)
 * const env = makeTestEnv({ PAYU_MERCHANT_KEY: "key" }); // with PayU
 * ```
 */
export function makeTestEnv(overrides?: Partial<TestEnv>): TestEnv {
  return {
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    OPENAI_API_KEY: "",
    API_KEY_SALT: "salt",
    MASTER_ADMIN_TOKEN: "",
    EMBEDDINGS_MODE: "stub",
    RATE_LIMIT_DO: makeRateLimitDoStub(),
    ...overrides,
  };
}

/**
 * Create a test env pre-configured for PayU billing tests.
 * All PayU vars/secrets have safe test defaults.
 */
export function makeTestEnvWithPayU(overrides?: Partial<TestEnv>): TestEnv {
  return makeTestEnv({
    PAYU_MERCHANT_KEY: "payu_key",
    PAYU_MERCHANT_SALT: "payu_salt",
    PAYU_BASE_URL: "https://secure.payu.in/_payment",
    PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice?form=2",
    PAYU_CURRENCY: "INR",
    PAYU_PRO_AMOUNT: "49.00",
    PAYU_PRODUCT_INFO: "MemoryNode Platform",
    PUBLIC_APP_URL: "https://app.example.com",
    BILLING_WEBHOOKS_ENABLED: "1",
    BILLING_RECONCILE_ON_AMBIGUITY: "1",
    ...overrides,
  });
}
