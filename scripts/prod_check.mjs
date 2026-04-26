#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const targetEnv = (process.env.CHECK_ENV ?? "production").trim().toLowerCase();
const viteApiBaseUrl = (process.env.VITE_API_BASE_URL ?? "https://api.memorynode.ai").trim();
const viteSurface = (process.env.VITE_APP_SURFACE ?? "console").trim();
const viteBuildSha = (process.env.VITE_BUILD_SHA ?? "prod-check-local").trim();

function runStep(label, command, env = {}) {
  console.log(`\n[prod:check] ${label}`);
  console.log(`[prod:check] $ ${command}`);
  const res = spawnSync(command, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
  });
  if ((res.status ?? 1) !== 0) {
    console.error(`\n[prod:check] FAIL at step: ${label}`);
    process.exit(res.status ?? 1);
  }
}

function main() {
  console.log(`[prod:check] starting (CHECK_ENV=${targetEnv})`);
  runStep("typecheck", "pnpm typecheck");
  runStep("tests", "pnpm test");
  runStep("critical flow checks", "pnpm critical:flows:check");
  runStep("config validation", "pnpm check:config", { CHECK_ENV: targetEnv });
  runStep("observability contracts", "pnpm check:observability-contracts");
  runStep("api build", "pnpm --filter @memorynode/api build");
  runStep(
    "dashboard build",
    "pnpm --filter @memorynode/dashboard build",
    {
      VITE_API_BASE_URL: viteApiBaseUrl,
      VITE_APP_SURFACE: viteSurface,
      VITE_BUILD_SHA: viteBuildSha,
    },
  );
  console.log("\n[prod:check] PASS");
}

main();

