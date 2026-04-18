#!/usr/bin/env node
/**
 * MemoryNode CLI — mn doctor | mn quickstart
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot() {
  let dir = path.resolve(__dirname, "..", "..", "..");
  for (let i = 0; i < 8; i++) {
    const ws = path.join(dir, "pnpm-workspace.yaml");
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(ws)) {
      try {
        const name = JSON.parse(fs.readFileSync(pkg, "utf8")).name;
        if (name === "memorynode-monorepo") return dir;
      } catch {
        /* continue */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function doctor() {
  const apiKey = (process.env.API_KEY ?? process.env.MEMORYNODE_API_KEY ?? "").trim();
  const baseUrl = (process.env.BASE_URL ?? process.env.MEMORYNODE_BASE_URL ?? "").trim();
  const root = findRepoRoot();
  const preflight = path.join(root, "scripts", "preflight_dev_env.mjs");

  if (fs.existsSync(preflight)) {
    const r = spawnSync(process.execPath, [preflight], { stdio: "inherit", cwd: root, env: process.env });
    if (r.status !== 0) return r.status ?? 1;
  } else {
    console.warn("[mn] preflight script not found; skipping monorepo check.");
  }

  if (apiKey && baseUrl) {
    const probe = path.join(root, "packages", "cli", "scripts", "probe-hosted.mjs");
    if (fs.existsSync(probe)) {
      const res = spawnSync(process.execPath, [probe], {
        stdio: "inherit",
        cwd: root,
        env: { ...process.env, API_KEY: apiKey, BASE_URL: baseUrl },
      });
      if (res.status !== 0) {
        console.warn("[mn] hosted probe failed (check BASE_URL and API_KEY).");
      }
    }
  } else {
    console.log("[mn] Set API_KEY + BASE_URL to probe hosted GET /v1/usage/today.");
  }

  console.log("[mn] doctor done.");
  return 0;
}

function quickstart() {
  const base = "https://api.memorynode.ai";
  console.log(`
MemoryNode — hosted quickstart (copy after exporting API_KEY)

export API_KEY=mn_live_xxx
export BASE_URL="${base}"

# 1) Save
curl -sS -X POST "$BASE_URL/v1/memories" \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \\
  -d '{"user_id":"user-1","namespace":"demo","text":"User prefers dark mode"}'

# 2) Search
curl -sS -X POST "$BASE_URL/v1/search" \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \\
  -d '{"user_id":"user-1","namespace":"demo","query":"theme","top_k":5}'

# 3) Context
curl -sS -X POST "$BASE_URL/v1/context" \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \\
  -d '{"user_id":"user-1","namespace":"demo","query":"What do we know about theme?","top_k":5}'

Docs: docs/start-here/README.md
`);
  return 0;
}

function main() {
  const cmd = (process.argv[2] ?? "").toLowerCase();
  if (cmd === "doctor") process.exit(doctor());
  if (cmd === "quickstart") process.exit(quickstart());
  console.error(`Usage: mn <doctor|quickstart>

  doctor      — run repo preflight (apps/api/.dev.vars) + optional hosted probe
  quickstart  — print curl template for hosted API`);
  process.exit(1);
}

main();
