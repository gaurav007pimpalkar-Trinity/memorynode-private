#!/usr/bin/env node
/**
 * Execute recommendation: fix or delete the "memorynode" Pages project.
 * Uses CLOUDFLARE_API_TOKEN (env or .env). Safe to run without delete flag.
 *
 * Usage:
 *   node scripts/cloudflare_pages_cleanup.mjs              # show status only
 *   DELETE_MEMORYNODE_PAGES=1 node scripts/cloudflare_pages_cleanup.mjs   # delete project
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadEnv() {
  try {
    const envPath = join(root, ".env");
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch (_) {}
}

loadEnv();

const BASE = "https://api.cloudflare.com/client/v4";
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token && process.env.CLOUDFLARE_API_TOKEN_FILE) {
  try {
    token = readFileSync(join(root, process.env.CLOUDFLARE_API_TOKEN_FILE), "utf8").trim();
  } catch (_) {}
}

const doDelete = process.env.DELETE_MEMORYNODE_PAGES === "1" || process.env.DELETE_MEMORYNODE_PAGES === "true";
const PROJECT_NAME = "memorynode";

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function cf(path, method = "GET", body = null) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const opt = { method, headers };
  if (body) opt.body = JSON.stringify(body);
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));
  if (!data.success && data.errors?.length) {
    throw new Error(`CF API ${path}: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

async function main() {
  if (!token) {
    console.error("CLOUDFLARE_API_TOKEN is required (env or .env in repo root).");
    process.exit(1);
  }

  const zones = await cf("/zones").then((d) => d.result ?? []);
  const accountId = zones[0]?.account?.id;
  if (!accountId) {
    console.error("Could not determine account ID from zones.");
    process.exit(1);
  }

  const projectsData = await cf(`/accounts/${accountId}/pages/projects`);
  const projects = projectsData.result ?? [];
  const project = projects.find((p) => (p.name ?? p.project_name) === PROJECT_NAME);

  if (!project) {
    console.log(`Pages project "${PROJECT_NAME}" not found. Nothing to do.`);
    return;
  }

  const detail = await cf(`/accounts/${accountId}/pages/projects/${encodeURIComponent(PROJECT_NAME)}`);
  const proj = detail.result ?? detail;
  const latest = proj.latest_deployment;

  console.log("Pages project:", PROJECT_NAME);
  console.log("  Subdomain:", proj.subdomain ?? project.subdomain ?? "—");
  console.log("  Domains:", (proj.domains ?? []).join(", ") || "—");
  if (latest) {
    console.log("  Latest deployment:");
    console.log("    ID:", latest.short_id ?? latest.id);
    console.log("    URL:", latest.url ?? "—");
    console.log("    Created:", latest.created_on ?? "—");
    const stage = latest.latest_stage ?? latest.stages?.find((s) => s.name === "build");
    if (stage) {
      console.log("    Latest stage:", stage.name, "→", stage.status);
    }
  } else {
    console.log("  Latest deployment: (none)");
  }

  if (!doDelete) {
    console.log("\nTo delete this project, run:");
    console.log(`  DELETE_MEMORYNODE_PAGES=1 node scripts/cloudflare_pages_cleanup.mjs`);
    return;
  }

  console.log(`\nDeleting Pages project "${PROJECT_NAME}"...`);
  await cf(`/accounts/${accountId}/pages/projects/${encodeURIComponent(PROJECT_NAME)}`, "DELETE");
  console.log("Deleted successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
