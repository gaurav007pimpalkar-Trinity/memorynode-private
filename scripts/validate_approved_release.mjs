#!/usr/bin/env node
/**
 * Strict validation for approved_release.json (staging artifact consumed by production).
 * Usage:
 *   node scripts/validate_approved_release.mjs <path-to-json> [--expect-head-sha <40-char-hex>]
 *
 * If GITHUB_OUTPUT is set and WRITE_GITHUB_OUTPUT=1, appends sha=, manifest_timestamp=, staging_run_id= lines.
 */
import fs from "node:fs";

function fail(message) {
  console.error(`[validate-approved-release] ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const path = argv[0];
let expectHead = null;
const i = argv.indexOf("--expect-head-sha");
if (i !== -1 && argv[i + 1]) {
  expectHead = String(argv[i + 1]).trim().toLowerCase();
}

if (!path) {
  fail("missing path to approved_release.json");
}
if (!fs.existsSync(path) || !fs.statSync(path).isFile()) {
  fail(`file not found or not a file: ${path}`);
}

let raw;
try {
  raw = fs.readFileSync(path, "utf8");
} catch (e) {
  fail(`cannot read file: ${(e && e.message) || e}`);
}

let o;
try {
  o = JSON.parse(raw);
} catch (e) {
  fail(`invalid JSON: ${(e && e.message) || e}`);
}

if (typeof o !== "object" || o === null || Array.isArray(o)) {
  fail("root JSON value must be a non-null object");
}

const sha = String(o.sha ?? "").trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sha)) {
  fail(`field "sha" must be a 40-character lowercase hex string; got ${JSON.stringify(o.sha)}`);
}

if (o.status !== "approved") {
  fail(`field "status" must be exactly "approved"; got ${JSON.stringify(o.status)}`);
}

const ts = String(o.timestamp ?? "").trim();
if (!ts) {
  fail('field "timestamp" must be a non-empty string');
}

if (o.staging_run_id != null) {
  const sid = o.staging_run_id;
  if (typeof sid !== "number" || !Number.isFinite(sid) || sid <= 0 || !Number.isInteger(sid)) {
    fail(`field "staging_run_id" must be a positive integer when present; got ${JSON.stringify(sid)}`);
  }
}

if (expectHead && sha !== expectHead) {
  fail(`manifest sha ${sha} does not match expected head ${expectHead}`);
}

if ((process.env.WRITE_GITHUB_OUTPUT ?? "").trim() === "1" && process.env.GITHUB_OUTPUT) {
  const out = process.env.GITHUB_OUTPUT;
  fs.appendFileSync(out, `sha=${sha}\n`);
  fs.appendFileSync(out, `manifest_timestamp=${ts.replace(/\r?\n/g, " ")}\n`);
  fs.appendFileSync(
    out,
    `manifest_staging_run_id=${o.staging_run_id != null ? String(o.staging_run_id) : ""}\n`,
  );
}

console.log(JSON.stringify({ sha, timestamp: ts, staging_run_id: o.staging_run_id ?? null }, null, 0));
