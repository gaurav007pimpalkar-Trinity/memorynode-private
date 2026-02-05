#!/usr/bin/env node
/**
 * Lightweight secret scan (local only, no uploads).
 * - Scans text files for obvious secret patterns.
 * - Skips heavy/irrelevant dirs: node_modules, dist, coverage, .wrangler, .turbo, .vite, .cache, .git, .tmp.
 * - Prints rule name + file path; never prints secret values.
 */

import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".wrangler",
  ".turbo",
  ".vite",
  ".cache",
  ".tmp",
  ".pnpm-store",
]);

// File-level skip patterns (extensions / globs)
const SKIP_EXT = new Set([".md", ".yml", ".yaml"]);
const MAX_BYTES = 1_000_000; // skip very large files

// Path-based allow/skip
function shouldSkipFile(filePath) {
  const lc = filePath.toLowerCase();
  if (lc.includes("/docs/") || lc.includes("\\docs\\")) return true;
  if (lc.endsWith(".example")) return true;
  if (lc.endsWith(".template")) return true;
  if (lc.endsWith(".env.example") || lc.endsWith(".env.e2e.example")) return true;
  if (lc.includes("/tests/") || lc.includes("\\tests\\")) return true;
  if (lc.includes("/.github/") || lc.includes("\\.github\\")) {
    const ext = path.extname(filePath);
    if (SKIP_EXT.has(ext)) return true;
  }
  const ext = path.extname(filePath);
  if (SKIP_EXT.has(ext)) return true;
  return false;
}

const RULES = [
  { name: "stripe_live_key", re: /sk_live_[0-9a-zA-Z]{16,}/ },
  { name: "stripe_test_key", re: /sk_test_[0-9a-zA-Z]{16,}/ },
  { name: "stripe_webhook_secret", re: /whsec_[0-9a-zA-Z]{16,}/ },
  { name: "slack_bot_token", re: /xoxb-[0-9]{10,}-[0-9]{10,}-[0-9A-Za-z]{10,}/ },
  { name: "private_key", re: /-----BEGIN (RSA |EC |DSA |)PRIVATE KEY-----/ },
  { name: "openai_key", re: /sk-[A-Za-z0-9]{32,}/ },
  // Env assignments (variable name plus plausible value on same line)
  {
    name: "env_assignment",
    re: /(SUPABASE_SERVICE_ROLE_KEY|MASTER_ADMIN_TOKEN|API_KEY_SALT|OPENAI_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)\s*[:=]\s*["']?[A-Za-z0-9_\-]{24,}["']?/,
  },
];

let scanned = 0;
let skipped = 0;
const matches = [];

function shouldSkipDir(dirName) {
  return SKIP_DIRS.has(dirName);
}

function scanFile(filePath) {
  if (shouldSkipFile(filePath)) {
    skipped += 1;
    return;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_BYTES) return;
    const text = fs.readFileSync(filePath, "utf8");
    scanned += 1;
    for (const rule of RULES) {
      if (rule.re.test(text)) {
        matches.push({ rule: rule.name, file: filePath });
      }
    }
  } catch {
    // ignore read errors
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      scanFile(path.join(dir, entry.name));
    }
  }
}

walk(process.cwd());

if (matches.length === 0) {
  console.log(`No secrets detected. scanned=${scanned}, skipped=${skipped}`);
  process.exit(0);
}

console.log("Potential secrets found (review and remove):");
for (const m of matches) {
  console.log(` - ${m.rule}: ${m.file}`);
}
console.log(`scanned=${scanned}, skipped=${skipped}`);
process.exit(1);
