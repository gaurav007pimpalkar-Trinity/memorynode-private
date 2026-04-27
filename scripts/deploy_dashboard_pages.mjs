#!/usr/bin/env node
/**
 * Production: build both dashboard surfaces (same commit SHA), deploy memorynode-console + memorynode-app,
 * then verify live URLs + matching version.json. Non-atomic Pages uploads are mitigated by:
 * - same VITE_BUILD_SHA in both dists before any upload
 * - re-upload BOTH projects once if wrangler or verify fails (transient CF / CDN lag)
 * - two-phase verify: (1) wrangler "peek" *.pages.dev URLs prove the upload; (2) custom domains with long backoff
 * - workflow still exits 1 if anything is wrong after recovery (never "silent success" on partial verify failure)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDashboardDeploySha } from "./dashboard_deploy_sha.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboardDir = path.join(root, "apps", "dashboard");
const buildScript = path.join(root, "scripts", "dashboard_build_prod_surfaces.mjs");
const verifyScript = path.join(root, "scripts", "verify_dashboard_pages_deploy.mjs");

for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (!(process.env[key] ?? "").trim()) {
    console.error(`[deploy_dashboard_pages] Missing required env: ${key}`);
    process.exit(1);
  }
}

const sha = resolveDashboardDeploySha();
if (!sha) {
  console.error(
    "[deploy_dashboard_pages] Could not resolve commit SHA. Set VITE_BUILD_SHA or GITHUB_SHA, or run from a git clone.",
  );
  process.exit(1);
}
console.log(`[deploy_dashboard_pages] BUILD_SHA=${sha} (both surfaces will embed this in version.json)`);

const envWithSha = { ...process.env, VITE_BUILD_SHA: sha };
const b = spawnSync(process.execPath, [buildScript], {
  cwd: root,
  stdio: "inherit",
  env: envWithSha,
});
if (b.status !== 0) process.exit(b.status ?? 1);

const consoleDist = path.join(dashboardDir, "dist-console");
const appDist = path.join(dashboardDir, "dist-app");
if (!existsSync(path.join(consoleDist, "index.html")) || !existsSync(path.join(appDist, "index.html"))) {
  console.error("[deploy_dashboard_pages] Build outputs missing; aborting before deploy.");
  process.exit(1);
}

function readDistGitSha(distDir) {
  const p = path.join(distDir, "version.json");
  if (!existsSync(p)) {
    throw new Error(`missing ${path.relative(root, p)}`);
  }
  const j = JSON.parse(readFileSync(p, "utf8"));
  return (j.gitSha ?? "").trim();
}

let cSha;
let aSha;
try {
  cSha = readDistGitSha(consoleDist);
  aSha = readDistGitSha(appDist);
} catch (e) {
  console.error("[deploy_dashboard_pages] Failed reading local version.json:", (e && e.message) || e);
  process.exit(1);
}

if (cSha !== sha || aSha !== sha || cSha !== aSha) {
  console.error("[deploy_dashboard_pages] Local dist SHAs must match BUILD_SHA before upload.", {
    BUILD_SHA: sha,
    distConsole: cSha,
    distApp: aSha,
  });
  process.exit(1);
}
console.log("[deploy_dashboard_pages] Local dist version.json pair OK (same SHA as BUILD_SHA).");

const consoleArg = path.relative(root, consoleDist).split(path.sep).join("/");
const appArg = path.relative(root, appDist).split(path.sep).join("/");

/** Strip ANSI so we can grep wrangler output reliably in CI */
function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Wrangler prints: "Take a peek over at https://<id>.<project>.pages.dev"
 * That URL reflects this upload immediately; custom domains may lag behind.
 */
function parsePeekUrl(log) {
  const text = stripAnsi(log);
  const m = text.match(/Take a peek over at (https:\/\/[^\s\x1b\)]+)/i);
  if (m) return m[1].replace(/[\s\)]+$/, "");
  const m2 = text.match(/(https:\/\/[a-f0-9]+\.[^\s]+\.pages\.dev)/i);
  return m2 ? m2[1].replace(/[\s\)]+$/, "") : "";
}

function peekOrigin(peekUrl) {
  try {
    return new URL(peekUrl).origin;
  } catch {
    return "";
  }
}

function pagesDeploy(projectName, dirArg) {
  const r = spawnSync("pnpm", ["exec", "wrangler", "pages", "deploy", dirArg, "--project-name", projectName], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32",
  });
  const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && combined) {
    process.stderr.write(combined);
  } else if (combined) {
    process.stdout.write(combined);
  }
  const peek = parsePeekUrl(combined);
  return { ok: r.status === 0, peek };
}

const pagesProjectConsole = (process.env.DASHBOARD_PAGES_PROJECT_CONSOLE ?? "memorynode-console").trim() || "memorynode-console";
const pagesProjectApp = (process.env.DASHBOARD_PAGES_PROJECT_APP ?? "memorynode-app").trim() || "memorynode-app";
console.log(`[deploy_dashboard_pages] Pages projects: console=${pagesProjectConsole} app=${pagesProjectApp}`);

function deployBoth() {
  const c = pagesDeploy(pagesProjectConsole, consoleArg);
  if (!c.ok) return { ok: false, consolePeek: c.peek, appPeek: "" };
  const a = pagesDeploy(pagesProjectApp, appArg);
  return { ok: a.ok, consolePeek: c.peek, appPeek: a.peek };
}

function runRemoteVerify(extraEnv = {}) {
  const r = spawnSync(process.execPath, [verifyScript], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_BUILD_SHA: sha, ...extraEnv },
  });
  return r.status === 0;
}

/** Phase 1: prove the bits Cloudflare just accepted (peek URLs). Phase 2: production hostnames (may lag). */
function verifyPagesRollout(consolePeek, appPeek) {
  const co = peekOrigin(consolePeek);
  const ao = peekOrigin(appPeek);
  if (co && ao) {
    console.log("[deploy_dashboard_pages] Verify phase 1: wrangler peek URLs (upload truth)");
    const okPeek = runRemoteVerify({
      DASHBOARD_VERIFY_CONSOLE_ORIGIN: co,
      DASHBOARD_VERIFY_APP_ORIGIN: ao,
      VERIFY_PAGES_ATTEMPTS: process.env.VERIFY_PAGES_PEEK_ATTEMPTS ?? "12",
      VERIFY_PAGES_DELAY_MS: process.env.VERIFY_PAGES_PEEK_DELAY_MS ?? "5000",
    });
    if (!okPeek) {
      console.error("[deploy_dashboard_pages] Peek URL verification failed — upload or build SHA mismatch.");
      return false;
    }
  } else {
    console.warn(
      "[deploy_dashboard_pages] Could not parse wrangler peek URLs; skipping phase 1 (rely on custom-domain verify only).",
    );
  }

  console.log("[deploy_dashboard_pages] Verify phase 2: custom domains (VERIFY_PAGES_* / DASHBOARD_VERIFY_* env)");
  return runRemoteVerify({
    VERIFY_PAGES_ATTEMPTS: process.env.VERIFY_PAGES_ATTEMPTS ?? "24",
    VERIFY_PAGES_DELAY_MS: process.env.VERIFY_PAGES_DELAY_MS ?? "10000",
  });
}

function printRecovery() {
  console.error("");
  console.error("[deploy_dashboard_pages] DEPLOY NOT VERIFIED — sites may be on different versions.");
  console.error("Re-run from the SAME commit after fixing Cloudflare / DNS / secrets:");
  console.error(`  VITE_BUILD_SHA=${sha} pnpm dashboard:deploy:pages`);
  console.error("Or verify only:");
  console.error(`  VITE_BUILD_SHA=${sha} pnpm dashboard:verify:pages`);
  console.error("");
}

let round = deployBoth();
if (!round.ok) {
  console.warn("[deploy_dashboard_pages] First upload round failed; retrying BOTH projects once...");
  round = deployBoth();
  if (!round.ok) {
    printRecovery();
    process.exit(1);
  }
}

if (!verifyPagesRollout(round.consolePeek, round.appPeek)) {
  console.warn("[deploy_dashboard_pages] Post-deploy verify failed (CDN lag or partial rollout). Re-uploading BOTH once...");
  round = deployBoth();
  if (!round.ok) {
    printRecovery();
    process.exit(1);
  }
  if (!verifyPagesRollout(round.consolePeek, round.appPeek)) {
    printRecovery();
    process.exit(1);
  }
}

console.log("[deploy_dashboard_pages] Done: both projects deployed and verify passed.");
