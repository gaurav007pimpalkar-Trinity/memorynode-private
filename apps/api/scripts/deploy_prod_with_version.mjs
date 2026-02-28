#!/usr/bin/env node
/**
 * Deploy production Worker with BUILD_VERSION set to short git SHA.
 * Cross-platform (Windows + macOS/Linux). Run from apps/api:
 *   pnpm run deploy:prod
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(__dirname, "..");

const sha = execSync("git rev-parse --short HEAD", {
  encoding: "utf-8",
  cwd: apiRoot,
})
  .trim()
  .replace(/\s+/g, "");

const cmd = `pnpm exec wrangler deploy --env production --var BUILD_VERSION=${sha}`;
execSync(cmd, {
  stdio: "inherit",
  cwd: apiRoot,
  env: { ...process.env, BUILD_VERSION: sha },
});
