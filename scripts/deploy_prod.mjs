#!/usr/bin/env node
/**
 * Push-button production deploy (guarded).
 * Steps:
 * 1) Preflight: stage=production + confirmation latch + required env + wrangler auth
 * 2) release gate (CHECK_ENV=production inside)
 * 3) db:check against prod DB
 * 4) wrangler deploy --env production
 * 5) Post-deploy smoke: /healthz and /v1/usage/today (auth)
 * 6) Optional: payu:webhook-test if PAYU_MERCHANT_KEY + PAYU_MERCHANT_SALT are set
 *
 * Safety: refuses to run unless DEPLOY_CONFIRM === "memorynode-prod".
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

function formatMissing(missing, target) {
  const hintStage = target === "production" ? "prod" : target;
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

async function getHealth(healthUrl) {
  try {
    const res = await fetch(healthUrl);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore parse errors
    }
    return {
      ok: res.ok,
      status: res.status,
      json,
      text,
      headers: {
        cfCacheStatus: res.headers.get("cf-cache-status") || "<absent>",
        age: res.headers.get("age") || "<absent>",
        cfRay: res.headers.get("cf-ray") || "<absent>",
        cacheControl: res.headers.get("cache-control") || "<absent>",
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: "",
      error: err,
      headers: {
        cfCacheStatus: "<unavailable>",
        age: "<unavailable>",
        cfRay: "<unavailable>",
        cacheControl: "<unavailable>",
      },
    };
  }
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureWranglerAuth() {
  try {
    runWrangler("whoami");
  } catch {
    fail(
      "Wrangler auth missing. From apps/api run `pnpm exec wrangler login` or set CLOUDFLARE_API_TOKEN before deploy.",
    );
  }
}

function injectBuildVersionIntoWrangler(envName, buildVersion) {
  const wranglerPath = path.join("apps", "api", "wrangler.toml");
  const tmpPath = path.join("apps", "api", `.wrangler.${envName}.tmp.toml`);
  const raw = fs.readFileSync(wranglerPath, "utf8");
  const blockRe = new RegExp(`\\[env\\.${envName}\\.vars\\]([\\s\\S]*?)(?=\\n\\[env\\.|$)`);
  const match = raw.match(blockRe);
  if (!match) throw new Error(`wrangler.toml missing [env.${envName}.vars] block`);
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
  const healthJson = await health.json().catch(() => ({}));
  if (healthJson?.status !== "ok") {
    fail(`healthz unexpected payload: ${JSON.stringify(healthJson).slice(0, 300)}`);
  }
  console.log(" healthz ok");

  console.log("[smoke] GET /v1/usage/today");
  const usageAttempts = 3;
  let lastUsageStatus = 0;
  let lastUsageBody = "<none>";
  for (let i = 0; i < usageAttempts; i++) {
    const attempt = i + 1;
    const usageUrl = `${baseUrl}/v1/usage/today?ts=${Date.now()}&attempt=${attempt}`;
    try {
      const usage = await fetch(usageUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const usageText = await usage.text();
      lastUsageStatus = usage.status;
      lastUsageBody = usageText;
      let usageJson = {};
      try {
        usageJson = JSON.parse(usageText);
      } catch {
        // leave as {}
      }
      if (usage.ok) {
        if (typeof usageJson !== "object") {
          fail("usage response not JSON object");
        }
        console.log(` usage ok (attempt ${attempt}/${usageAttempts})`);
        return;
      }
      console.warn(
        ` usage attempt ${attempt}/${usageAttempts} failed: status=${usage.status} body=${usageText.slice(0, 300)}`,
      );
      if (attempt < usageAttempts && (usage.status === 401 || usage.status >= 500)) {
        await wait(2000);
        continue;
      }
      fail(`usage failed: status=${usage.status} body=${usageText.slice(0, 300)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(` usage attempt ${attempt}/${usageAttempts} fetch error: ${message}`);
      if (attempt < usageAttempts) {
        await wait(2000);
        continue;
      }
      fail(`usage failed: network error after ${usageAttempts} attempts: ${message}`);
    }
  }
  fail(`usage failed: status=${lastUsageStatus} body=${lastUsageBody.slice(0, 300)}`);
}

async function main() {
  const stageRaw = (process.env.DEPLOY_ENV ?? process.env.STAGE ?? "production").toLowerCase();
  const stage = stageRaw || "production";

  const missing = [];
  if (stage !== "production") missing.push("DEPLOY_ENV (or STAGE) must be production");
  if (process.env.DEPLOY_CONFIRM !== "memorynode-prod") {
    missing.push('DEPLOY_CONFIRM="memorynode-prod"');
  }

  const dbUrl = resolveEnvOrAlias("DATABASE_URL", ["SUPABASE_DB_URL", "SUPABASE_DATABASE_URL"]);
  if (!dbUrl) missing.push("DATABASE_URL");

  const baseUrl = resolveEnvOrAlias("BASE_URL");
  if (!baseUrl) missing.push("BASE_URL");

  const apiKey = resolveEnvOrAlias("MEMORYNODE_API_KEY");
  if (!apiKey) missing.push("MEMORYNODE_API_KEY");

  if (missing.length > 0) {
    fail(formatMissing(missing, "production"));
  }

  const buildVersion = resolveBuildVersion();
  const expectedStage = "production";
  process.env.BUILD_VERSION = buildVersion;
  const wranglerConfig = injectBuildVersionIntoWrangler("production", buildVersion);

  console.log("Production deploy starting…");
  console.log(` STAGE=${stage}`);
  console.log(` BASE_URL=${baseUrl}`);
  console.log(` MEMORYNODE_API_KEY=${mask(apiKey)}`);
  console.log(` BUILD_VERSION=${buildVersion}`);

  const pre = await getHealth(`${baseUrl}/healthz?ts=${Date.now()}`);
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
    runWrangler(`deploy --env production --config ${path.basename(wranglerConfig)} --dry-run`, {
      BUILD_VERSION: buildVersion,
    });
    console.log("\n✅ Dry-run complete (build + wrangler parsed)");
    return;
  }

  // Strict gate including DB migrate/verify
  run("pnpm release:gate:full");

  // Deploy to production environment
  runWrangler(`deploy --env production --config ${path.basename(wranglerConfig)}`, {
    BUILD_VERSION: buildVersion,
  });

  // Verify new version is live
  console.log("\n[verify] polling /healthz for new version...");
  let seenVersion = null;
  let lastStatus = 0;
  let lastBody = "<none>";
  let lastHealthUrl = `${baseUrl}/healthz`;
  const attempts = 25;
  const propagationDelayNoticeAfter = 10;
  for (let i = 0; i < attempts; i++) {
    const attempt = i + 1;
    const healthUrl = `${baseUrl}/healthz?ts=${Date.now()}&attempt=${attempt}`;
    lastHealthUrl = healthUrl;
    const res = await getHealth(healthUrl);
    lastStatus = res.status;
    lastBody = res?.text ?? "<none>";
    seenVersion = res?.json?.build_version ?? res?.json?.version;
    const stageSeenRaw = res.json?.stage?.toLowerCase?.();
    const stageMatch = !stageSeenRaw || stageSeenRaw === expectedStage || stageSeenRaw === "prod";
    const bodySnippet = (res?.text ?? "<none>").slice(0, 280);
    console.log(
      ` attempt ${attempt}/${attempts}: url=${healthUrl} status=${res.status} seenVersion=${seenVersion ?? "<none>"} cf-cache-status=${res.headers.cfCacheStatus} age=${res.headers.age} cf-ray=${res.headers.cfRay}`,
    );
    if (!seenVersion) {
      console.log(`  response body: ${bodySnippet}`);
    }
    if (res.ok && res.json?.status === "ok" && seenVersion === buildVersion && stageMatch) {
      const stageSeen = res.json?.stage ?? "<unset>";
      console.log(
        ` healthz ok: status=${res.status}, version=${seenVersion}, stage=${stageSeen}, attempts=${attempt}, url=${healthUrl}`,
      );
      break;
    }
    if (attempt === propagationDelayNoticeAfter) {
      console.warn(
        ` propagation delay suspected after ${propagationDelayNoticeAfter} attempts; continuing verification window...`,
      );
    }
    await wait(3000);
  }
  if (seenVersion !== buildVersion) {
    fail(
      `Deployed version not observed. expectedBuildVersion=${buildVersion} oldVersion=${oldVersion ?? "<none>"} lastObservedBuildVersion=${seenVersion ?? "<none>"} attemptsMade=${attempts} finalUrl=${lastHealthUrl} lastStatus=${lastStatus} lastBody=${lastBody}`,
    );
  }

  // Post-deploy smoke
  await smoke(baseUrl, apiKey);

  // Optional PayU webhook test if secrets present
  if (process.env.PAYU_MERCHANT_KEY && process.env.PAYU_MERCHANT_SALT) {
    console.log("\n[optional] Running payu:webhook-test (PAYU_MERCHANT_KEY + PAYU_MERCHANT_SALT present)");
    run("pnpm payu:webhook-test");
  } else {
    console.log("\n[optional] Skipping payu:webhook-test (PAYU_MERCHANT_KEY/PAYU_MERCHANT_SALT not set)");
  }

  console.log("\n✅ Production deploy complete");
}

main().catch((err) => {
  fail(err?.message || String(err));
});
