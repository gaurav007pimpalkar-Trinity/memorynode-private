#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const forbidden = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "MASTER_ADMIN_TOKEN",
  "API_KEY_SALT",
  "OPENAI_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
];

const filePath = path.resolve("apps/api/wrangler.toml");
if (!fs.existsSync(filePath)) {
  console.error(`wrangler.toml not found at ${filePath}`);
  process.exit(1);
}

const raw = fs.readFileSync(filePath, "utf8");
const varsIndex = raw.search(/^\[vars\]/m);
if (varsIndex === -1) {
  console.log("No [vars] block found; nothing to check.");
  process.exit(0);
}

const afterVars = raw.slice(varsIndex + "[vars]".length);
const nextSectionMatch = afterVars.match(/\n\[[^\]]+\]/);
const varsBlock = nextSectionMatch ? afterVars.slice(0, nextSectionMatch.index) : afterVars;

const hits = forbidden.filter((key) => new RegExp(`^${key}\\s*=`, "m").test(varsBlock));
if (hits.length > 0) {
  console.error(
    `Forbidden secrets found in [vars]: ${hits.join(
      ", ",
    )}. Move them to Cloudflare secrets via ` + "`wrangler secret put <NAME>`.",
  );
  process.exit(1);
}

console.log("wrangler.toml [vars] is clean (no secrets).");
