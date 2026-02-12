#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const workspaceRoots = ["apps", "packages"];
const workspacePackages = [];
const requiredScripts = ["lint", "typecheck", "test", "build"];
const errors = [];

for (const workspaceRoot of workspaceRoots) {
  const rootDir = path.join(root, workspaceRoot);
  if (!existsSync(rootDir)) continue;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relPkg = path.posix.join(workspaceRoot, entry.name, "package.json");
    if (existsSync(path.join(root, relPkg))) workspacePackages.push(relPkg);
  }
}
workspacePackages.sort();

const noopPatterns = [
  /^:$/,
  /^true$/i,
  /^echo(?:\s+.*)?$/i,
  /^printf(?:\s+.*)?$/i,
  /^rem(?:\s+.*)?$/i,
];

function isNoOpScript(script) {
  const parts = script
    .split(/&&|\|\|/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every((part) => noopPatterns.some((pattern) => pattern.test(part)));
}

if (workspacePackages.length === 0) {
  console.error("workspace script check failed: no workspace package.json files found under apps/* or packages/*");
  process.exit(1);
}

for (const rel of workspacePackages) {
  const abs = path.join(root, rel);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    errors.push(`${rel}: failed to read/parse package.json (${(err && err.message) || "unknown error"})`);
    continue;
  }
  const scripts = pkg && typeof pkg === "object" ? pkg.scripts : null;
  for (const scriptName of requiredScripts) {
    const script = scripts && typeof scripts[scriptName] === "string" ? scripts[scriptName].trim() : "";
    if (!script) {
      errors.push(`${rel}: missing script "${scriptName}"`);
      continue;
    }
    if (isNoOpScript(script)) {
      errors.push(`${rel}: script "${scriptName}" appears to be a no-op (${script})`);
    }
  }
}

if (errors.length > 0) {
  console.error("workspace script check failed:");
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log(`workspace script check passed (${workspacePackages.length} packages)`);
