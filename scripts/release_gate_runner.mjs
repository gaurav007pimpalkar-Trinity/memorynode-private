#!/usr/bin/env node
/**
 * Cross-platform release gate runner (no DB mutation).
 * Required checks:
 *   - lint, typecheck, test
 *   - migrations:check
 *   - secrets scans (env + tracked files)
 * Optional:
 *   - build when RELEASE_INCLUDE_BUILD=1
 */

import { execSync } from "node:child_process";

const inferredCheckEnv = process.env.CHECK_ENV ?? (process.env.CI ? "staging" : "production");
const env = { ...process.env, CHECK_ENV: inferredCheckEnv };

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env });
}

try {
  const checks = [
    "pnpm check:workspace-scripts",
    "pnpm check:tracked-artifacts",
    "pnpm check:typed-entry",
    "pnpm check:workspace-scope",
    "pnpm check:observability-contracts",
    "pnpm check:runbooks",
    "pnpm check:least-privilege",
    "pnpm check:wrangler",
    "pnpm check:config",
    "pnpm secrets:check",
    "pnpm secrets:check:tracked",
    "pnpm migrations:check",
    "pnpm openapi:check",
    "pnpm -w lint",
    "pnpm -w typecheck",
    "pnpm -w test",
  ];
  if ((process.env.RELEASE_INCLUDE_BUILD ?? "").trim() === "1") {
    checks.push("pnpm -w build");
  }
  for (const cmd of checks) {
    run(cmd);
  }
} catch (err) {
  process.exit(err?.status || 1);
}
