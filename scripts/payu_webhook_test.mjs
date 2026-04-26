#!/usr/bin/env node
/**
 * PayU webhook validation + idempotency smoke.
 *
 * Required env:
 * - BASE_URL: Public API base (e.g., https://api-staging.memorynode.ai)
 *   For split Workers, set CONTROL_PLANE_BASE_URL to the control-plane host for POST /v1/billing/webhook (defaults to BASE_URL).
 *   Set CONTROL_PLANE_SECRET to match the Worker secret (header `x-internal-secret`).
 * - PAYU_MERCHANT_KEY: PayU merchant key
 * - PAYU_MERCHANT_SALT: PayU merchant salt
 *
 * Optional:
 * - MEMORYNODE_API_KEY: sent as Bearer for deployments with custom auth middlewares
 */

import crypto from "node:crypto";

const {
  BASE_URL,
  CONTROL_PLANE_BASE_URL,
  CONTROL_PLANE_SECRET,
  PAYU_MERCHANT_KEY,
  PAYU_MERCHANT_SALT,
  MEMORYNODE_API_KEY,
} = process.env;
const REQUEST_ID_PREFIX = (process.env.PAYU_SMOKE_REQUEST_ID_PREFIX ?? "payu-webhook").trim() || "payu-webhook";

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
    productinfo: "MemoryNode Platform",
    firstname: "MemoryNode",
    email: "ws1@example.com",
    udf1: "ws1",
    udf2: "",
    udf3: "",
    udf4: "",
    udf5: "",
  };
}

function signPayload(payload) {
  // PayU reverse hash sequence:
  // SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
  const sequence = [
    PAYU_MERCHANT_SALT,
    payload.status,
    "",
    "",
    "",
    "",
    payload.udf5 ?? "",
    payload.udf4 ?? "",
    payload.udf3 ?? "",
    payload.udf2 ?? "",
    payload.udf1 ?? "",
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
  const requestId = `${REQUEST_ID_PREFIX}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const headers = { "content-type": "application/json" };
  if (MEMORYNODE_API_KEY) headers.Authorization = `Bearer ${MEMORYNODE_API_KEY}`;
  headers["x-request-id"] = requestId;
  if (CONTROL_PLANE_SECRET && `${CONTROL_PLANE_SECRET}`.trim()) {
    headers["x-internal-secret"] = `${CONTROL_PLANE_SECRET}`.trim();
  }

  const webhookBase = (CONTROL_PLANE_BASE_URL ?? BASE_URL ?? "").replace(/\/$/, "");
  const res = await fetch(`${webhookBase}/v1/billing/webhook`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    text,
    requestId: res.headers.get("x-request-id") ?? requestId,
  };
}

async function main() {
  if (!(BASE_URL ?? "").trim() && !(CONTROL_PLANE_BASE_URL ?? "").trim()) {
    throw new Error("Missing BASE_URL or CONTROL_PLANE_BASE_URL (webhook host).");
  }
  requireEnv("PAYU_MERCHANT_KEY");
  requireEnv("PAYU_MERCHANT_SALT");

  const id = `mih_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const validPayload = makePayload(id);
  validPayload.hash = signPayload(validPayload);

  const invalidPayload = { ...validPayload, hash: "invalid" };

  const invalid = await postWebhook(invalidPayload);
  console.log(`[${invalid.ok ? "FAIL" : "PASS"}] webhook_invalid_sig request_id=${invalid.requestId} status=${invalid.status}`);

  const first = await postWebhook(validPayload);
  console.log(`[${first.ok ? "PASS" : "FAIL"}] webhook_valid_sig_first request_id=${first.requestId} status=${first.status}`);

  const replay = await postWebhook(validPayload);
  console.log(`[${replay.ok ? "PASS" : "FAIL"}] webhook_replay request_id=${replay.requestId} status=${replay.status}`);

  const pass = !invalid.ok && first.ok && replay.ok;
  console.log(`PayU webhook test: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
