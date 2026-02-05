#!/usr/bin/env node
/**
 * Cross-platform release gate runner (no DB).
 * Sets CHECK_ENV=production and runs:
 *   check:typed-entry -> check:wrangler -> check:config -> lint -> typecheck -> test:ci
 */

import { execSync } from "node:child_process";

const env = { ...process.env, CHECK_ENV: "production" };

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env });
}

try {
  run("pnpm check:typed-entry");
  run("pnpm check:wrangler");
  run("pnpm check:config");
  run("pnpm lint");
  run("pnpm typecheck");
  run("pnpm test:ci");
} catch (err) {
  process.exit(err?.status || 1);
}
