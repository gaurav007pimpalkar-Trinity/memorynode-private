/**
 * Shared PayU test utilities: webhook signing, verify-API mocking, seed helpers.
 *
 * Phase 7: typed mocks.
 */

import crypto from "node:crypto";
import { vi } from "vitest";

// ---------- Webhook signature generation ----------

/**
 * Sign a PayU webhook payload for test verification.
 * Uses the same reverse-hash algorithm as the real PayU flow:
 * `SALT|status|||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|KEY`
 *
 * @param payload - PayU callback fields
 * @param merchantKey - test merchant key (default "payu_key")
 * @param merchantSalt - test merchant salt (default "payu_salt")
 */
export function signPayUWebhookSimple(
  payload: Record<string, string>,
  merchantKey = "payu_key",
  merchantSalt = "payu_salt",
): string {
  const seq = [
    merchantSalt,
    payload.status ?? "",
    "", // additionalCharges
    "", // reserved
    "", // reserved
    "", // reserved
    "", // reserved
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
    merchantKey,
  ].join("|");
  return crypto.createHash("sha512").update(seq).digest("hex");
}

// ---------- PayU Verify API mock ----------

export interface MockPayUVerifyOptions {
  amount?: string;
  currency?: string;
  paymentId?: string;
}

/**
 * Stub `globalThis.fetch` to return a PayU verify API response.
 * Call this in your test before triggering webhook processing.
 *
 * @param status - PayU transaction status to return
 * @param options - optional overrides for amount/currency/paymentId
 */
export function mockPayUVerifyApi(
  status: "success" | "failure" | "pending" | "canceled",
  options?: MockPayUVerifyOptions,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      let txnid = "txn_default";
      const body = init?.body;
      if (body instanceof URLSearchParams) {
        txnid = body.get("var1") ?? txnid;
      } else if (typeof body === "string") {
        txnid = new URLSearchParams(body).get("var1") ?? txnid;
      }
      return new Response(
        JSON.stringify({
          status: 1,
          transaction_details: {
            [txnid]: {
              txnid,
              status,
              amount: options?.amount ?? "49.00",
              currency: options?.currency ?? "INR",
              mihpayid: options?.paymentId ?? `mih_${txnid}`,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

/**
 * Restore `fetch` to its real implementation after test.
 * Call in `afterEach`.
 */
const _realFetch = globalThis.fetch;
export function restoreFetch(): void {
  vi.stubGlobal("fetch", _realFetch);
}

// ---------- Seed helpers ----------

/**
 * Build a minimal PayU webhook payload for testing.
 * Auto-signs the hash.
 */
export function buildTestWebhookPayload(
  overrides?: Partial<Record<string, string>>,
  merchantKey = "payu_key",
  merchantSalt = "payu_salt",
): Record<string, string> {
  const payload: Record<string, string> = {
    txnid: "txn_test_001",
    mihpayid: "mih_test_001",
    status: "success",
    amount: "49.00",
    productinfo: "MemoryNode Platform",
    firstname: "Test",
    email: "test@example.com",
    key: merchantKey,
    udf1: "ws1",
    udf2: "",
    udf3: "",
    udf4: "",
    udf5: "",
    ...overrides,
  };
  payload.hash = signPayUWebhookSimple(payload, merchantKey, merchantSalt);
  return payload;
}
