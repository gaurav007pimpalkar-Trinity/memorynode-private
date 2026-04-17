#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defaultApiSourceFiles, scanWorkspaceScopeViolations } from "./lib/workspace_scope_guard.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

const files = defaultApiSourceFiles(repoRoot);
const violations = scanWorkspaceScopeViolations({ files });

if (violations.length > 0) {
  console.error("Workspace scope guard failed:");
  for (const v of violations) {
    console.error(`- ${v.file}:${v.line} ${v.message}`);
  }
  process.exit(1);
}

console.log(`Workspace scope guard passed (${files.length} files checked).`);
