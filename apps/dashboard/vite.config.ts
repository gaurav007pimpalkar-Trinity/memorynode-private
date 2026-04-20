import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));

function resolveGitHeadSha(): string {
  try {
    return execSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: dashboardDir }).trim();
  } catch {
    return "";
  }
}

/** Commit id baked into version.json; same resolution as scripts/dashboard_deploy_sha.mjs */
function productionBuildSha(loaded: Record<string, string>): string {
  const pick = (key: string) => (process.env[key] ?? loaded[key])?.trim();
  return (pick("VITE_BUILD_SHA") ?? "") || (process.env.GITHUB_SHA ?? "").trim() || resolveGitHeadSha();
}

function requireProdDashboardEnv() {
  return {
    name: "require-prod-dashboard-env",
    config(_, { mode }) {
      if (mode !== "production") return;
      const loaded = loadEnv(mode, dashboardDir, "VITE_");
      const pick = (key: string) => (process.env[key] ?? loaded[key])?.trim();
      const base = pick("VITE_API_BASE_URL");
      const isLocalhost = base && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(base);
      if (!base || isLocalhost) {
        throw new Error(
          "Production build requires VITE_API_BASE_URL to be set and non-localhost. " +
            "Set it in the environment, or copy apps/dashboard/.env.production.example to apps/dashboard/.env.production and fill the URL.",
        );
      }
      const surface = (pick("VITE_APP_SURFACE") ?? "").toLowerCase();
      if (surface !== "console" && surface !== "app") {
        throw new Error(
          'Production build requires VITE_APP_SURFACE to be exactly "console" (customer dashboard) or "app" (founder dashboard). ' +
            "Set it in the environment or in apps/dashboard/.env.production (see .env.console.production.example / .env.app.production.example).",
        );
      }
      const buildSha = productionBuildSha(loaded);
      if (!buildSha) {
        throw new Error(
          "Production build requires a commit SHA for deploy safety (version.json). " +
            "Set VITE_BUILD_SHA, or run in GitHub Actions (GITHUB_SHA), or build from a git checkout so `git rev-parse HEAD` works.",
        );
      }
    },
  };
}

/** Emits /version.json in the bundle root for post-deploy pairing checks (console vs app). */
function emitDashboardVersionJson(): Plugin {
  let buildSha = "";
  let surface = "";
  return {
    name: "emit-dashboard-version-json",
    configResolved(config) {
      if (config.command !== "build" || config.mode !== "production") return;
      const loaded = loadEnv(config.mode, dashboardDir, "VITE_");
      buildSha = productionBuildSha(loaded);
      surface = ((process.env.VITE_APP_SURFACE ?? loaded.VITE_APP_SURFACE) ?? "").trim();
    },
    generateBundle() {
      if (!buildSha) return;
      const payload = JSON.stringify({
        gitSha: buildSha,
        surface: surface || "unknown",
        builtAt: new Date().toISOString(),
      });
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: payload,
      });
    },
  };
}

export default defineConfig({
  plugins: [requireProdDashboardEnv(), emitDashboardVersionJson(), react()],
  server: {
    port: 4173,
  },
});
