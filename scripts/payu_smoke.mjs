#!/usr/bin/env node
/**
 * Combined PayU smoke (safe by default).
 *
 * Runs, if present:
 *  - scripts/payu_staging_smoke.mjs
 *  - scripts/payu_webhook_test.mjs
 *
 * Then verifies GET /v1/billing/status returns entitlement fields with
 * plan_status/effective_plan invariants.
 *
 * Required env:
 *  - BASE_URL (or PAYU_SMOKE_BASE_URL)
 *  - MEMORYNODE_API_KEY
 *
 * Safety:
 *  - Refuses likely production hosts unless PAYU_SMOKE_ALLOW_LIVE=1.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function printStep(step, ok, requestId = "n/a", details = "") {
  const status = ok ? "PASS" : "FAIL";
  const suffix = details ? ` ${details}` : "";
  console.log(`[${status}] ${step} request_id=${requestId}${suffix}`);
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function normalizeBaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("BASE_URL must be a valid absolute URL.");
  }
  const host = parsed.hostname.toLowerCase();
  const allowLive = isTruthy(process.env.PAYU_SMOKE_ALLOW_LIVE ?? "");
  const safeHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.includes("staging") ||
    host.includes("sandbox");
  const likelyProd = host === "api.memorynode.ai" || host.includes("prod");
  if (!allowLive && (!safeHost || likelyProd)) {
    fail(
      `Refusing to run payu:smoke against host=${host}. Use staging/sandbox/localhost or set PAYU_SMOKE_ALLOW_LIVE=1.`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function extractRequestId(output) {
  if (!output) return "n/a";
  const matches = [...output.matchAll(/request_id=([A-Za-z0-9._:-]+)/g)];
  if (!matches.length) return "n/a";
  return matches[matches.length - 1][1] ?? "n/a";
}

function runNodeScriptIfPresent(relativePath, stepName, requestIdPrefix) {
  const fullPath = path.resolve(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    printStep(stepName, true, "n/a", "(skipped: script missing)");
    return true;
  }
  const run = spawnSync(process.execPath, [fullPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PAYU_SMOKE_REQUEST_ID_PREFIX: `${requestIdPrefix}-${stepName}`,
    },
    encoding: "utf8",
  });
  const ok = (run.status ?? 1) === 0;
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
  const requestId = extractRequestId(output);
  printStep(stepName, ok, requestId, `exit=${run.status ?? 1}`);
  if (!ok) {
    if (output) {
      const excerpt = output.split(/\r?\n/).slice(-10).join("\n");
      console.error(excerpt);
    }
  }
  return ok;
}

async function verifyBillingStatus(baseUrl, apiKey) {
  const requestId = `payu-smoke-${Date.now().toString(36)}`;
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/billing/status`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-request-id": requestId,
      },
    });
  } catch (err) {
    printStep("billing_status", false, requestId, "fetch_failed");
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    console.error(message);
    return false;
  }

  const echoedRequestId = response.headers.get("x-request-id") ?? requestId;
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep json null
  }

  if (!response.ok) {
    printStep("billing_status", false, echoedRequestId, `status=${response.status}`);
    if (text) console.error(text.slice(0, 300));
    return false;
  }

  const plan = typeof json?.plan === "string" ? json.plan : null;
  const planStatus = typeof json?.plan_status === "string" ? json.plan_status : null;
  const effectivePlan = typeof json?.effective_plan === "string" ? json.effective_plan : null;
  const hasShape = Boolean(plan && planStatus && effectivePlan);
  const active = planStatus === "active" || planStatus === "trialing";
  const invariantHolds = active ? effectivePlan === plan : effectivePlan === "launch";
  const ok = hasShape && invariantHolds;

  printStep(
    "billing_status",
    ok,
    echoedRequestId,
    `status=${response.status} plan=${plan ?? "?"} plan_status=${planStatus ?? "?"} effective_plan=${effectivePlan ?? "?"}`,
  );
  return ok;
}

async function main() {
  const baseUrlRaw = (process.env.PAYU_SMOKE_BASE_URL ?? process.env.BASE_URL ?? "").trim();
  const apiKey = (process.env.MEMORYNODE_API_KEY ?? "").trim();
  if (!baseUrlRaw) fail("Missing BASE_URL (or PAYU_SMOKE_BASE_URL).");
  if (!apiKey) fail("Missing MEMORYNODE_API_KEY.");

  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  process.env.BASE_URL = baseUrl;
  const requestIdPrefix = `payu-smoke-${Date.now().toString(36)}`;

  let pass = true;
  pass = runNodeScriptIfPresent("scripts/payu_staging_smoke.mjs", "payu_staging_smoke", requestIdPrefix) && pass;
  pass = runNodeScriptIfPresent("scripts/payu_webhook_test.mjs", "payu_webhook_smoke", requestIdPrefix) && pass;
  pass = (await verifyBillingStatus(baseUrl, apiKey)) && pass;

  console.log(`PayU smoke: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
