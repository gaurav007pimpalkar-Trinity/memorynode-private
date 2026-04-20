#!/usr/bin/env node
/**
 * Builds apps/dashboard twice from the same commit: console surface and app (founder) surface.
 * Both use VITE_API_BASE_URL from the environment (required). No deploy — see deploy_dashboard_pages.mjs.
 * VITE_BUILD_SHA is set to the same value for both builds (from env or resolveDashboardDeploySha).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDashboardDeploySha } from "./dashboard_deploy_sha.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboardDir = path.join(root, "apps", "dashboard");

const buildSha = resolveDashboardDeploySha();
if (!buildSha) {
  console.error(
    "[dashboard_build_prod_surfaces] Could not resolve commit SHA. Set VITE_BUILD_SHA or GITHUB_SHA, or use a git checkout.",
  );
  process.exit(1);
}
console.log(`[dashboard_build_prod_surfaces] VITE_BUILD_SHA=${buildSha}`);

function runViteBuild(extraEnv, outDir) {
  const env = { ...process.env, ...extraEnv };
  const r = spawnSync("pnpm", ["exec", "vite", "build", "--outDir", outDir], {
    cwd: dashboardDir,
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const api = (process.env.VITE_API_BASE_URL ?? "").trim();
if (!api) {
  console.error("[dashboard_build_prod_surfaces] Set VITE_API_BASE_URL (e.g. https://api.memorynode.ai).");
  process.exit(1);
}

const consoleBase = (process.env.VITE_CONSOLE_BASE_URL ?? "https://console.memorynode.ai").trim();

runViteBuild(
  {
    VITE_BUILD_SHA: buildSha,
    VITE_APP_SURFACE: "console",
    VITE_API_BASE_URL: api,
    VITE_CONSOLE_BASE_URL: consoleBase,
    VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY,
  },
  "dist-console",
);

if (!existsSync(path.join(dashboardDir, "dist-console", "index.html"))) {
  console.error("[dashboard_build_prod_surfaces] Console build did not produce dist-console/index.html.");
  process.exit(1);
}

runViteBuild(
  {
    VITE_BUILD_SHA: buildSha,
    VITE_APP_SURFACE: "app",
    VITE_API_BASE_URL: api,
    VITE_CONSOLE_BASE_URL: consoleBase,
  },
  "dist-app",
);

if (!existsSync(path.join(dashboardDir, "dist-app", "index.html"))) {
  console.error("[dashboard_build_prod_surfaces] App build did not produce dist-app/index.html.");
  process.exit(1);
}

console.log("[dashboard_build_prod_surfaces] OK: dist-console + dist-app");
