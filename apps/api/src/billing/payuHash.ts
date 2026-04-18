/**
 * PayU request/response hash helpers (shared by billing + webhooks).
 */

import type { Env } from "../env.js";

export type PayUWebhookPayload = {
  key?: string;
  txnid?: string;
  mihpayid?: string;
  status?: string;
  hash?: string;
  amount?: string;
  productinfo?: string;
  firstname?: string;
  email?: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  currency?: string;
  addedon?: string;
  [key: string]: unknown;
};

export type PayURequestHashFields = {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  salt: string;
};

function payURequestHashSequence(fields: PayURequestHashFields): string {
  return [
    fields.key,
    fields.txnid,
    fields.amount,
    fields.productinfo,
    fields.firstname,
    fields.email,
    fields.udf1 ?? "",
    fields.udf2 ?? "",
    fields.udf3 ?? "",
    fields.udf4 ?? "",
    fields.udf5 ?? "",
    "",
    "",
    "",
    "",
    "",
    fields.salt,
  ].join("|");
}

function payUHashReverseSequence(
  payload: PayUWebhookPayload,
  env: Pick<Env, "PAYU_MERCHANT_SALT" | "PAYU_MERCHANT_KEY">,
): string {
  return [
    env.PAYU_MERCHANT_SALT ?? "",
    payload.status ?? "",
    "",
    "",
    "",
    "",
    "",
    payload.udf5 ?? "",
    payload.udf4 ?? "",
    payload.udf3 ?? "",
    payload.udf2 ?? "",
    payload.udf1 ?? "",
    payload.email ?? "",
    payload.firstname ?? "",
    payload.productinfo ?? "",
    payload.amount ?? "",
    payload.txnid ?? "",
    env.PAYU_MERCHANT_KEY ?? "",
  ].join("|");
}

export function buildPayURequestHashInput(fields: PayURequestHashFields): string {
  return payURequestHashSequence(fields);
}

export function buildPayUResponseReverseHashInput(
  payload: PayUWebhookPayload,
  env: Pick<Env, "PAYU_MERCHANT_SALT" | "PAYU_MERCHANT_KEY">,
): string {
  return payUHashReverseSequence(payload, env);
}

export async function computeSha512Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-512", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
