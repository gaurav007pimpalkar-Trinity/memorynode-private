#!/usr/bin/env node
/**
 * Stripe webhook validation + idempotency smoke.
 *
 * Required env:
 * - BASE_URL: API base (e.g., https://api-staging.memorynode.ai)
 * - STRIPE_WEBHOOK_SECRET: signing secret for the staging endpoint
 * - MEMORYNODE_API_KEY: API key if the webhook enforces auth (should be open, but include for safety)
 *
 * Flow:
 * 1) Send payload with INVALID signature -> expect 400/401.
 * 2) Send payload with VALID signature -> expect 2xx.
 * 3) Replay same event id with VALID signature -> expect 2xx and no error (idempotent).
 *
 * No secrets are printed.
 */

import crypto from "node:crypto";

const { BASE_URL, STRIPE_WEBHOOK_SECRET, MEMORYNODE_API_KEY } = process.env;

function requireEnv(name) {
  if (!process.env[name] || `${process.env[name]}`.trim() === "") {
    throw new Error(`Missing required env: ${name}`);
  }
}

try {
  requireEnv("BASE_URL");
  requireEnv("STRIPE_WEBHOOK_SECRET");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const headersBase = {
  "content-type": "application/json",
};
if (MEMORYNODE_API_KEY) headersBase.Authorization = `Bearer ${MEMORYNODE_API_KEY}`;

function signPayload(secret, payload, timestamp) {
  const toSign = `${timestamp}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(toSign).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

async function postWebhook(payload, signatureHeader) {
  const res = await fetch(`${BASE_URL}/v1/billing/webhook`, {
    method: "POST",
    headers: {
      ...headersBase,
      "stripe-signature": signatureHeader,
    },
    body: payload,
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

async function main() {
  const event = {
    id: `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "event",
    type: "invoice.payment_succeeded",
    data: {
      object: {
        id: `in_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        customer: "cus_test123",
        metadata: { workspace_id: "ws_test" },
      },
    },
  };
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const validSig = signPayload(STRIPE_WEBHOOK_SECRET, payload, ts);

  // Invalid signature
  const invalid = await postWebhook(payload, "t=0,v1=badsignature");
  console.log(`[webhook invalid sig] ${invalid.ok ? "FAIL" : "PASS"} status=${invalid.status}`);

  // Valid signature
  const first = await postWebhook(payload, validSig);
  console.log(`[webhook valid sig first] ${first.ok ? "PASS" : "FAIL"} status=${first.status}`);

  // Replay same event id (idempotency)
  const replay = await postWebhook(payload, validSig);
  console.log(`[webhook replay] ${replay.ok ? "PASS" : "FAIL"} status=${replay.status}`);

  const allPass = !invalid.ok && first.ok && replay.ok;
  console.log(`Stripe webhook test: ${allPass ? "PASS" : "FAIL"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
