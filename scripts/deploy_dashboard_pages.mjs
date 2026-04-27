#!/usr/bin/env node
/**
 * Production: build both dashboard surfaces (same commit SHA), deploy memorynode-console + memorynode-app,
 * then verify live URLs + matching version.json. Non-atomic Pages uploads are mitigated by:
 * - same VITE_BUILD_SHA in both dists before any upload
 * - re-upload BOTH projects once if wrangler or verify fails (transient CF / CDN lag)
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

function pagesDeploy(projectName, dirArg) {
  const r = spawnSync(
    "pnpm",
    ["exec", "wrangler", "pages", "deploy", dirArg, "--project-name", projectName],
    { cwd: root, stdio: "inherit", env: process.env, shell: process.platform === "win32" },
  );
  return r.status === 0;
}

const pagesProjectConsole = (process.env.DASHBOARD_PAGES_PROJECT_CONSOLE ?? "memorynode-console").trim() || "memorynode-console";
const pagesProjectApp = (process.env.DASHBOARD_PAGES_PROJECT_APP ?? "memorynode-app").trim() || "memorynode-app";
console.log(`[deploy_dashboard_pages] Pages projects: console=${pagesProjectConsole} app=${pagesProjectApp}`);

function deployBoth() {
  if (!pagesDeploy(pagesProjectConsole, consoleArg)) return false;
  if (!pagesDeploy(pagesProjectApp, appArg)) return false;
  return true;
}

function runRemoteVerify() {
  const r = spawnSync(process.execPath, [verifyScript], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_BUILD_SHA: sha },
  });
  return r.status === 0;
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

if (!deployBoth()) {
  console.warn("[deploy_dashboard_pages] First upload round failed; retrying BOTH projects once...");
  if (!deployBoth()) {
    printRecovery();
    process.exit(1);
  }
}

if (!runRemoteVerify()) {
  console.warn("[deploy_dashboard_pages] Post-deploy verify failed (CDN lag or partial rollout). Re-uploading BOTH once...");
  if (!deployBoth()) {
    printRecovery();
    process.exit(1);
  }
  if (!runRemoteVerify()) {
    printRecovery();
    process.exit(1);
  }
}

console.log("[deploy_dashboard_pages] Done: both projects deployed and verify passed.");
