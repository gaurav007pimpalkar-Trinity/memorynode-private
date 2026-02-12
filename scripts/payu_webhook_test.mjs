#!/usr/bin/env node
/**
 * PayU webhook validation + idempotency smoke.
 *
 * Required env:
 * - BASE_URL: API base (e.g., https://api-staging.memorynode.ai)
 * - PAYU_MERCHANT_KEY: PayU merchant key
 * - PAYU_MERCHANT_SALT: PayU merchant salt
 *
 * Optional:
 * - MEMORYNODE_API_KEY: sent as Bearer for deployments with custom auth middlewares
 */

import crypto from "node:crypto";

const { BASE_URL, PAYU_MERCHANT_KEY, PAYU_MERCHANT_SALT, MEMORYNODE_API_KEY } = process.env;

function requireEnv(name) {
  if (!process.env[name] || `${process.env[name]}`.trim() === "") {
    throw new Error(`Missing required env: ${name}`);
  }
}

function makePayload(eventId) {
  return {
    key: PAYU_MERCHANT_KEY,
    txnid: `txn_${eventId}`,
    mihpayid: eventId,
    status: "success",
    amount: "49.00",
    productinfo: "MemoryNode Platform Pro",
    firstname: "MemoryNode",
    email: "ws1@example.com",
    udf1: "ws1",
  };
}

function signPayload(payload) {
  const sequence = [
    PAYU_MERCHANT_SALT,
    payload.status,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    payload.udf1,
    payload.email,
    payload.firstname,
    payload.productinfo,
    payload.amount,
    payload.txnid,
    PAYU_MERCHANT_KEY,
  ].join("|");
  return crypto.createHash("sha512").update(sequence).digest("hex");
}

async function postWebhook(payload) {
  const headers = { "content-type": "application/json" };
  if (MEMORYNODE_API_KEY) headers.Authorization = `Bearer ${MEMORYNODE_API_KEY}`;

  const res = await fetch(`${BASE_URL}/v1/billing/webhook`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function main() {
  requireEnv("BASE_URL");
  requireEnv("PAYU_MERCHANT_KEY");
  requireEnv("PAYU_MERCHANT_SALT");

  const id = `mih_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const validPayload = makePayload(id);
  validPayload.hash = signPayload(validPayload);

  const invalidPayload = { ...validPayload, hash: "invalid" };

  const invalid = await postWebhook(invalidPayload);
  console.log(`[webhook invalid sig] ${invalid.ok ? "FAIL" : "PASS"} status=${invalid.status}`);

  const first = await postWebhook(validPayload);
  console.log(`[webhook valid sig first] ${first.ok ? "PASS" : "FAIL"} status=${first.status}`);

  const replay = await postWebhook(validPayload);
  console.log(`[webhook replay] ${replay.ok ? "PASS" : "FAIL"} status=${replay.status}`);

  const pass = !invalid.ok && first.ok && replay.ok;
  console.log(`PayU webhook test: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
