#!/usr/bin/env node
/**
 * Optional preflight check for smoke credentials.
 * Verifies whether the smoke key's workspace is currently entitled by querying
 * GET /v1/usage/today (same entitlement gate used by smoke flow).
 */

import { createHash } from "node:crypto";

function requireEnv(names) {
  for (const n of names) {
    const val = process.env[n];
    if (val && String(val).trim() !== "") return val.trim();
  }
  throw new Error(`Missing required env var (provide one of): ${names.join(", ")}`);
}

function keyIdentifier(apiKey) {
  const clean = String(apiKey ?? "").trim();
  const fp = createHash("sha256").update(clean).digest("hex").slice(0, 8);
  return `${fp}...${clean.slice(-4)}`;
}

async function main() {
  const baseUrl = requireEnv(["PROD_BASE_URL", "BASE_URL"]);
  const apiKey = requireEnv(["MEMORYNODE_SMOKE_API_KEY", "PROD_API_KEY", "MEMORYNODE_API_KEY"]);
  const keyId = keyIdentifier(apiKey);

  const res = await fetch(new URL("/v1/usage/today", baseUrl), {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text diagnostics
  }

  if (res.status === 402 && String(json?.error?.code ?? "").toUpperCase() === "ENTITLEMENT_REQUIRED") {
    console.error(`[smoke-entitlement] key_id=${keyId} entitlement=inactive`);
    console.error(
      "Smoke failed: API key workspace is not entitled (ENTITLEMENT_REQUIRED).",
    );
    process.exit(2);
  }

  if (!res.ok) {
    console.error(`[smoke-entitlement] key_id=${keyId} check_failed status=${res.status}`);
    console.error(text.slice(0, 300));
    process.exit(1);
  }

  console.log(
    `[smoke-entitlement] key_id=${keyId} entitlement=active plan=${String(json?.plan ?? "unknown")}`,
  );
}

main().catch((err) => {
  console.error(`[smoke-entitlement] unexpected_error ${err.message}`);
  process.exit(1);
});

