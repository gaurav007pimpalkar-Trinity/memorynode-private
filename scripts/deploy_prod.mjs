#!/usr/bin/env node
/**
 * Push-button production deploy (guarded).
 * Steps:
 * 1) Preflight: stage=production + confirmation latch + required env + wrangler auth
 * 2) release gate (CHECK_ENV=production inside)
 * 3) db:check against prod DB
 * 4) wrangler deploy --env production
 * 5) Post-deploy smoke: /healthz and /v1/usage/today (auth)
 * 6) Optional: stripe:webhook-test if STRIPE_WEBHOOK_SECRET is set
 *
 * Safety: refuses to run unless DEPLOY_CONFIRM === "memorynode-prod".
 */

import { execSync } from "node:child_process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function mask(value) {
  if (!value) return "<empty>";
  if (value.length <= 8) return `${value[0]}***${value[value.length - 1]}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || `${v}`.trim() === "") {
    fail(`Missing required env var: ${name}`);
  }
  return v;
}

function run(cmd, extraEnv = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

async function getHealth(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/healthz`);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore parse errors
    }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err };
  }
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureWranglerAuth() {
  try {
    execSync("pnpm -C apps/api wrangler whoami", { stdio: "inherit" });
  } catch {
    fail(
      "Wrangler auth missing. Run `pnpm -C apps/api wrangler login` or set CLOUDFLARE_API_TOKEN before deploy.",
    );
  }
}

async function smoke(baseUrl, apiKey) {
  console.log("\n[smoke] GET /healthz");
  const health = await fetch(`${baseUrl}/healthz`);
  if (!health.ok) {
    const body = await health.text();
    fail(`healthz failed: status=${health.status} body=${body.slice(0, 300)}`);
  }
  const healthJson = await health.json().catch(() => ({}));
  if (healthJson?.status !== "ok") {
    fail(`healthz unexpected payload: ${JSON.stringify(healthJson).slice(0, 300)}`);
  }
  console.log(" healthz ok");

  console.log("[smoke] GET /v1/usage/today");
  const usage = await fetch(`${baseUrl}/v1/usage/today`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const usageText = await usage.text();
  let usageJson = {};
  try {
    usageJson = JSON.parse(usageText);
  } catch {
    // leave as {}
  }
  if (!usage.ok) {
    fail(`usage failed: status=${usage.status} body=${usageText.slice(0, 300)}`);
  }
  if (typeof usageJson !== "object") {
    fail("usage response not JSON object");
  }
  console.log(" usage ok");
}

async function main() {
  const stage = (process.env.STAGE ?? process.env.DEPLOY_ENV ?? "").toLowerCase();
  if (stage !== "production") {
    fail("Set STAGE=production (or DEPLOY_ENV=production) to run this deploy.");
  }

  if (process.env.DEPLOY_CONFIRM !== "memorynode-prod") {
    fail('Refusing to deploy: set DEPLOY_CONFIRM="memorynode-prod" to continue.');
  }

  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) fail("Missing SUPABASE_DB_URL (or DATABASE_URL) for migrations.");
  const baseUrl = requireEnv("BASE_URL");
  const apiKey = requireEnv("MEMORYNODE_API_KEY");
  const buildVersion = new Date().toISOString();
  const expectedStage = "production";

  console.log("Production deploy starting…");
  console.log(` STAGE=${stage}`);
  console.log(` BASE_URL=${baseUrl}`);
  console.log(` MEMORYNODE_API_KEY=${mask(apiKey)}`);
  console.log(` BUILD_VERSION=${buildVersion}`);

  const pre = await getHealth(baseUrl);
  const oldVersion = pre?.json?.version;
  if (pre.ok) {
    console.log(` prehealth: status=${pre.status}, oldVersion=${oldVersion ?? "<none>"}`);
  } else {
    console.log(" prehealth unavailable (will continue)");
  }

  ensureWranglerAuth();

  // Strict gate including DB migrate/verify
  run("pnpm release:gate:full");

  // Deploy to production environment
  run("pnpm -C apps/api wrangler deploy --env production", { BUILD_VERSION: buildVersion });

  // Verify new version is live
  console.log("\n[verify] polling /healthz for new version...");
  let seenVersion = null;
  let lastStatus = 0;
  const attempts = 10;
  for (let i = 0; i < attempts; i++) {
    const res = await getHealth(baseUrl);
    lastStatus = res.status;
    seenVersion = res?.json?.version;
    const stageSeenRaw = res.json?.stage?.toLowerCase?.();
    const stageMatch = !stageSeenRaw || stageSeenRaw === expectedStage || stageSeenRaw === "prod";
    if (res.ok && res.json?.status === "ok" && seenVersion === buildVersion && stageMatch) {
      const stageSeen = res.json?.stage ?? "<unset>";
      console.log(
        ` healthz ok: status=${res.status}, version=${seenVersion}, stage=${stageSeen}, attempts=${i + 1}`,
      );
      break;
    }
    const stageMsg = res.json?.stage ? ` stage=${res.json.stage}` : "";
    console.log(
      ` attempt ${i + 1}/${attempts}: status=${res.status}, seenVersion=${seenVersion ?? "<none>"}${stageMsg} (expect ${buildVersion}, stage=${expectedStage})`,
    );
    await wait(3000);
  }
  if (seenVersion !== buildVersion) {
    fail(
      `Deployed version not observed. oldVersion=${oldVersion ?? "<none>"} lastVersion=${seenVersion ?? "<none>"} lastStatus=${lastStatus}`,
    );
  }

  // Post-deploy smoke
  await smoke(baseUrl, apiKey);

  // Optional Stripe webhook test if secrets present
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    console.log("\n[optional] Running stripe:webhook-test (STRIPE_WEBHOOK_SECRET present)");
    run("pnpm stripe:webhook-test");
  } else {
    console.log("\n[optional] Skipping stripe:webhook-test (STRIPE_WEBHOOK_SECRET not set)");
  }

  console.log("\n✅ Production deploy complete");
}

main().catch((err) => {
  fail(err?.message || String(err));
});
