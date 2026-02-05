#!/usr/bin/env node
/**
 * Stripe staging smoke test (no DB writes beyond what the API normally does).
 *
 * Required env:
 * - BASE_URL: full base URL of the deployed API (e.g., https://api-staging.memorynode.ai)
 * - STRIPE_TEST_SECRET_KEY: Stripe test secret key (used only to check presence; not sent)
 * - STRIPE_WEBHOOK_SECRET: Webhook secret (presence check only here)
 * - MEMORYNODE_API_KEY: API key for auth (if the API requires it for billing endpoints)
 *
 * This script:
 *  - GET  /v1/billing/status
 *  - POST /v1/billing/checkout
 *  - POST /v1/billing/portal
 *
 * It prints PASS/FAIL summaries without leaking secrets.
 */

import crypto from "node:crypto";

const { BASE_URL, STRIPE_TEST_SECRET_KEY, STRIPE_WEBHOOK_SECRET, MEMORYNODE_API_KEY } = process.env;

function requireEnv(name) {
  if (!process.env[name] || `${process.env[name]}`.trim() === "") {
    throw new Error(`Missing required env: ${name}`);
  }
}

try {
  requireEnv("BASE_URL");
  requireEnv("STRIPE_TEST_SECRET_KEY");
  requireEnv("STRIPE_WEBHOOK_SECRET");
  requireEnv("MEMORYNODE_API_KEY");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const headersBase = {
  "content-type": "application/json",
  Authorization: `Bearer ${MEMORYNODE_API_KEY}`,
};

async function checkStatus() {
  const res = await fetch(`${BASE_URL}/v1/billing/status`, { headers: headersBase });
  const ok = res.ok;
  const body = await res.text();
  console.log(`[status] ${ok ? "PASS" : "FAIL"} ${res.status}`);
  if (!ok) console.log(body);
  return ok;
}

async function checkout() {
  const res = await fetch(`${BASE_URL}/v1/billing/checkout`, {
    method: "POST",
    headers: headersBase,
  });
  const ok = res.ok;
  const body = await res.text();
  const hasUrl = body.includes("url");
  console.log(`[checkout] ${ok && hasUrl ? "PASS" : "FAIL"} ${res.status}`);
  if (!ok || !hasUrl) console.log(body);
  return ok && hasUrl;
}

async function portal() {
  const res = await fetch(`${BASE_URL}/v1/billing/portal`, {
    method: "POST",
    headers: headersBase,
  });
  const ok = res.ok;
  const body = await res.text();
  const hasUrl = body.includes("url");
  console.log(`[portal] ${ok && hasUrl ? "PASS" : "FAIL"} ${res.status}`);
  if (!ok || !hasUrl) console.log(body);
  return ok && hasUrl;
}

async function main() {
  let pass = true;
  pass &&= await checkStatus();
  pass &&= await checkout();
  pass &&= await portal();
  console.log(`Stripe staging smoke: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
