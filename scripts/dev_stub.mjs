#!/usr/bin/env node
/**
 * Guided local dev: preflight then wrangler dev for apps/api.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const pre = spawnSync(process.execPath, [path.join(root, "scripts", "preflight_dev_env.mjs")], {
  stdio: "inherit",
  cwd: root,
});
if (pre.status !== 0) process.exit(pre.status ?? 1);

console.log("\nStarting API (wrangler dev)… See docs/self-host/LOCAL_DEV.md\n");

const wr = spawnSync(
  "pnpm",
  ["exec", "wrangler", "dev"],
  {
    stdio: "inherit",
    cwd: path.join(root, "apps", "api"),
    shell: true,
    env: { ...process.env },
  },
);
process.exit(wr.status ?? 1);
