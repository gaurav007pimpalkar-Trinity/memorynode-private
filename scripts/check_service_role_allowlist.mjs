#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const allowlistPath = path.join(root, "scripts", "security", "service_role_allowlist.json");

function fail(message) {
  console.error(`service-role allowlist check failed: ${message}`);
  process.exit(1);
}

function parseAllowlist() {
  let raw;
  try {
    raw = readFileSync(allowlistPath, "utf8");
  } catch (error) {
    fail(`cannot read allowlist at ${allowlistPath}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    fail("allowlist is not valid JSON");
  }
  return json;
}

function validateAllowlistShape(json) {
  if (!Array.isArray(json.allowed_files)) {
    fail("allowed_files must be an array");
  }
  if (json.allowed_files.length === 0) {
    fail("allowed_files cannot be empty");
  }
  const seen = new Set();
  const invalid = [];
  for (const entry of json.allowed_files) {
    if (typeof entry !== "string") {
      invalid.push(String(entry));
      continue;
    }
    const normalized = entry.replace(/\\/g, "/");
    const broadPattern =
      normalized.includes("*") ||
      normalized.endsWith("/") ||
      normalized === "." ||
      normalized === "./" ||
      normalized.startsWith("/") ||
      normalized.startsWith("scripts/") ||
      normalized.startsWith("apps/") && !normalized.includes(".") ||
      normalized === "apps" ||
      normalized === "scripts";
    const allowedPattern = /^[a-zA-Z0-9._/-]+\.(ts|js|mjs|cjs)$/;
    if (broadPattern || !allowedPattern.test(normalized)) {
      invalid.push(entry);
      continue;
    }
    if (seen.has(normalized)) {
      invalid.push(`${entry} (duplicate)`);
      continue;
    }
    seen.add(normalized);
  }
  if (invalid.length > 0) {
    fail(`unexpected/broad allowlist patterns: ${invalid.join(", ")}`);
  }
}

function getChangedFiles(base, head) {
  try {
    const out = execSync(`git diff --name-only "${base}" "${head}"`, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/\\/g, "/"));
  } catch {
    return [];
  }
}

function validatePrJustificationIfAllowlistChanged() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  if (eventName !== "pull_request") return;

  const base = process.env.DIFF_BASE?.trim();
  const head = process.env.DIFF_HEAD?.trim();
  if (!base || !head) return;

  const changedFiles = getChangedFiles(base, head);
  const allowlistRelPath = "scripts/security/service_role_allowlist.json";
  if (!changedFiles.includes(allowlistRelPath)) return;

  const prBody = (process.env.PR_BODY ?? "").toLowerCase();
  const hasJustification =
    prBody.includes("service-role justification:") ||
    prBody.includes("why service-role is required here");
  if (!hasJustification) {
    fail(
      `PR modifies ${allowlistRelPath} but is missing justification. Include either "Service-role justification:" or "why service-role is required here" in PR body.`,
    );
  }
}

const allowlist = parseAllowlist();
validateAllowlistShape(allowlist);
validatePrJustificationIfAllowlistChanged();

console.log("service-role allowlist check passed.");
