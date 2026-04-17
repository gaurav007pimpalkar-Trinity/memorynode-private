#!/usr/bin/env node
/**
 * Push-button staging deploy:
 * 1) Validates required env for staging
 * 2) Runs release gate + db checks
 * 3) Deploys via wrangler --env staging
 * 4) Runs post-deploy smoke (healthz + authed endpoint)
 *
 * Usage (PowerShell):
 *   $env:STAGE=\"staging\"; $env:SUPABASE_DB_URL=\"postgres://...\"; `
 *   $env:BASE_URL=\"https://api-staging.memorynode.ai\"; `
 *   $env:MEMORYNODE_API_KEY=\"mn_xxx\"; pnpm deploy:staging
 *
 * Usage (bash):
 *   STAGE=staging SUPABASE_DB_URL=postgres://... \\
 *   BASE_URL=https://api-staging.memorynode.ai \\
 *   MEMORYNODE_API_KEY=mn_xxx \\
 *   pnpm deploy:staging
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function mask(value) {
  if (!value) return "<empty>";
  if (value.length <= 8) return `${value[0]}***${value[value.length - 1]}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function gatherEnv(names) {
  const found = {};
  for (const n of names) {
    const v = process.env[n];
    if (v && `${v}`.trim() !== "") {
      found[n] = v;
    }
  }
  return found;
}

function resolveEnvOrAlias(primary, aliases = []) {
  const candidates = gatherEnv([primary, ...aliases]);
  const first = Object.entries(candidates)[0];
  return first ? first[1] : "";
}

function billingWebhooksEnabled() {
  const raw = `${process.env.BILLING_WEBHOOKS_ENABLED ?? "1"}`.trim().toLowerCase();
  return !["0", "false", "off", "no", ""].includes(raw);
}

function formatMissing(missing, target) {
  const hintStage = target === "staging" ? "staging" : "production";
  const bash = missing
    .map((k) => `${k}=<value>`)
    .join(" ");
  const ps = missing.map((k) => `$env:${k}='<value>'`).join("; ");
  return [
    `Missing required env vars: ${missing.join(", ")}`,
    "Examples:",
    `  bash: ${bash} pnpm deploy:${hintStage}`,
    `  pwsh: ${ps}; pnpm deploy:${hintStage}`,
  ].join("\n");
}

function run(cmd, extraEnv = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

function runWrangler(args, extraEnv = {}) {
  const cmd = `pnpm exec wrangler ${args}`;
  console.log(`\n$ (apps/api) ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: "apps/api", env: { ...process.env, ...extraEnv } });
}

function resolveBuildVersion() {
  const fromEnv = (process.env.BUILD_VERSION ?? "").trim();
  if (fromEnv) return fromEnv;
  const timestamp = new Date().toISOString();
  const fromGitSha = (process.env.GIT_SHA ?? "").trim();
  if (fromGitSha) return `${timestamp}-${fromGitSha}`;
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return sha ? `${timestamp}-${sha}` : timestamp;
  } catch {
    return timestamp;
  }
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
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: "", error: err };
  }
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureWranglerAuth() {
  try {
    runWrangler("whoami");
  } catch (err) {
    fail(
      "Wrangler auth missing. From apps/api run `pnpm exec wrangler login` (or set CLOUDFLARE_API_TOKEN) before deploy.",
    );
  }
}

function injectBuildVersionIntoWrangler(envName, buildVersion) {
  const wranglerPath = path.join("apps", "api", "wrangler.toml");
  const tmpPath = path.join("apps", "api", `.wrangler.${envName}.tmp.toml`);
  const raw = fs.readFileSync(wranglerPath, "utf8");
  const blockRe = new RegExp(`\\[env\\.${envName}\\.vars\\]([\\s\\S]*?)(?=\\n\\[env\\.|$)`);
  const match = raw.match(blockRe);
  if (!match) {
    throw new Error(`wrangler.toml missing [env.${envName}.vars] block`);
  }
  const block = match[0];
  const hasLine = /^\s*BUILD_VERSION\s*=.*/m.test(block);
  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const headerRe = new RegExp(`\\[env\\.${envName}\\.vars\\]\\r?\\n`);
  const updated = hasLine
    ? block.replace(/^\s*BUILD_VERSION\s*=.*$/m, `BUILD_VERSION = "${buildVersion}"`)
    : block.replace(headerRe, `[env.${envName}.vars]${eol}BUILD_VERSION = "${buildVersion}"${eol}`);
  const finalToml = raw.replace(blockRe, updated);
  fs.writeFileSync(tmpPath, finalToml);
  return tmpPath;
}

async function smoke(baseUrl, apiKey) {
  console.log("\n[smoke] GET /healthz");
  const health = await fetch(`${baseUrl}/healthz`);
  if (!health.ok) {
    const body = await health.text();
    fail(`healthz failed: status=${health.status} body=${body.slice(0, 300)}`);
  }
  console.log(" healthz ok");

  console.log("[smoke] GET /v1/usage/today");
  const usage = await fetch(`${baseUrl}/v1/usage/today`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const usageText = await usage.text();
  let usageJson = null;
  try {
    usageJson = usageText ? JSON.parse(usageText) : null;
  } catch {
    // ignore parse failures; handled by status checks below
  }
  const entitlementBlocked =
    usage.status === 402 &&
    (usageJson?.error?.code === "ENTITLEMENT_REQUIRED" || usageJson?.error?.code === "ENTITLEMENT_EXPIRED");
  if (!usage.ok && !entitlementBlocked) {
    fail(`usage failed: status=${usage.status} body=${usageText.slice(0, 300)}`);
  }
  if (entitlementBlocked) {
    console.log(` usage blocked by entitlement (${usageJson?.error?.code})`);
  } else {
    console.log(" usage ok");
  }
}

async function main() {
  const stageRaw = (process.env.DEPLOY_ENV ?? process.env.STAGE ?? "staging").toLowerCase();
  const stage = stageRaw || "staging";

  const missing = [];
  if (stage !== "staging") missing.push("DEPLOY_ENV (or STAGE) must be staging");

  const dbUrl = resolveEnvOrAlias("DATABASE_URL", ["SUPABASE_DB_URL", "SUPABASE_DATABASE_URL"]);
  if (!dbUrl) missing.push("DATABASE_URL");

  const baseUrl = resolveEnvOrAlias("BASE_URL");
  if (!baseUrl) missing.push("BASE_URL");

  const apiKey = resolveEnvOrAlias("MEMORYNODE_API_KEY");
  if (!apiKey) missing.push("MEMORYNODE_API_KEY");

  if (missing.length > 0) {
    fail(formatMissing(missing, "staging"));
  }

  const buildVersion = resolveBuildVersion();
  const expectedStage = "staging";
  process.env.BUILD_VERSION = buildVersion;
  const wranglerConfig = injectBuildVersionIntoWrangler("staging", buildVersion);

  console.log("Staging deploy starting…");
  console.log(` STAGE=${stage}`);
  console.log(` BASE_URL=${baseUrl}`);
  console.log(` MEMORYNODE_API_KEY=${mask(apiKey)}`);
  console.log(` BUILD_VERSION=${buildVersion}`);

  const pre = await getHealth(baseUrl);
  const oldVersion = pre?.json?.build_version ?? pre?.json?.version;
  if (pre.ok) {
    console.log(` prehealth: status=${pre.status}, oldVersion=${oldVersion ?? "<none>"}`);
  } else {
    console.log(" prehealth unavailable (will continue)");
  }

  ensureWranglerAuth();

  const isDryRun = `${process.env.DRY_RUN ?? ""}` === "1";
  if (isDryRun) {
    console.log("\nDRY_RUN=1 set: running validation + build only (no deploy)");
    runWrangler(`deploy --env staging --config ${path.basename(wranglerConfig)} --dry-run`, {
      BUILD_VERSION: buildVersion,
    });
    console.log("\n✅ Dry-run complete (build + wrangler parsed)");
    return;
  }

  // Strict gate including DB migrate/verify
  run("pnpm release:gate:full", { CHECK_ENV: "staging" });

  // Deploy to staging environment
  runWrangler(`deploy --env staging --config ${path.basename(wranglerConfig)}`, {
    BUILD_VERSION: buildVersion,
  });

  // Verify new version is live
  console.log("\n[verify] polling /healthz for new version...");
  let seenVersion = null;
  let lastStatus = 0;
  let lastBody = "<none>";
  const attempts = 10;
  for (let i = 0; i < attempts; i++) {
    const res = await getHealth(baseUrl);
    lastStatus = res.status;
    lastBody = res?.text ?? "<none>";
    seenVersion = res?.json?.build_version ?? res?.json?.version;
    const stageSeen = res.json?.stage?.toLowerCase?.();
    const stageMatch = !stageSeen || stageSeen === expectedStage;
    if (res.ok && res.json?.status === "ok" && seenVersion === buildVersion && stageMatch) {
      const stagePretty = res.json?.stage ?? "<unset>";
      console.log(
        ` healthz ok: status=${res.status}, version=${seenVersion}, stage=${stagePretty}, attempts=${i + 1}`,
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
      `Deployed version not observed. oldVersion=${oldVersion ?? "<none>"} lastVersion=${seenVersion ?? "<none>"} lastStatus=${lastStatus} lastBody=${lastBody}`,
    );
  }

  // Post-deploy smoke
  await smoke(baseUrl, apiKey);

  // Optional PayU webhook test when billing is enabled and secrets are present.
  if (billingWebhooksEnabled() && process.env.PAYU_MERCHANT_KEY && process.env.PAYU_MERCHANT_SALT) {
    console.log(
      "\n[optional] Running payu:webhook-test (billing enabled and PAYU_MERCHANT_KEY + PAYU_MERCHANT_SALT present)",
    );
    run("pnpm payu:webhook-test");
  } else if (!billingWebhooksEnabled()) {
    console.log("\n[optional] Skipping payu:webhook-test (BILLING_WEBHOOKS_ENABLED=0)");
  } else {
    console.log("\n[optional] Skipping payu:webhook-test (PAYU_MERCHANT_KEY/PAYU_MERCHANT_SALT not set)");
  }

  console.log("\n✅ Staging deploy complete");
}

main().catch((err) => {
  fail(err?.message || String(err));
});
