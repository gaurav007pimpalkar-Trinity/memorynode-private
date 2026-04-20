#!/usr/bin/env node
/**
 * Idempotent governance banners (run: node scripts/apply_doc_banners.mjs).
 * Does not modify SOURCE_OF_TRUTH files except where listed for banner type.
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const INTERNAL = `## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

`;

const SUPPORTING = `## ℹ️ Supporting Documentation

This document is a guide.  
For exact API behavior, refer to:
- \`docs/external/API_USAGE.md\`
- \`docs/external/openapi.yaml\` (run \`pnpm openapi:gen\` to regenerate)

---

`;

function walkMd(dir, acc = []) {
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return acc;
  } catch {
    return acc;
  }
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isFile() && name.endsWith(".md")) acc.push(p);
    else if (st.isDirectory()) walkMd(p, acc);
  }
  return acc;
}

function prepend(abs, banner, marker) {
  const s = readFileSync(abs, "utf8");
  if (s.includes(marker)) return;
  writeFileSync(abs, `${banner}${s}`, "utf8");
  console.log("banner:", abs.replace(/\\/g, "/"));
}

// Internal tree
for (const f of walkMd(join(root, "docs/internal"))) prepend(f, INTERNAL, "Internal Operational Document");

// Apps — operational READMEs
for (const f of [join(root, "apps/api/README.md"), join(root, "apps/dashboard/README.md")]) {
  try {
    statSync(f);
    prepend(f, INTERNAL, "Internal Operational Document");
  } catch {
    /* skip */
  }
}

// Docs root — ops / incident / launch (not API truth)
const internalTop = [
  "docs/OPERATIONS.md",
  "docs/INCIDENT_PROCESS.md",
  "docs/BACKUP_RESTORE.md",
  "docs/E2E_CRITICAL_PATH.md",
  "docs/PRODUCTION_REQUIREMENTS.md",
  "docs/PROD_SETUP_CHECKLIST.md",
  "docs/LAUNCH_CHECKLIST.md",
  "docs/LAUNCH_RUNBOOK.md",
  "docs/SECURITY_READINESS_ONE_PAGER.md",
  "docs/FOUNDER_SECRETS_CREDENTIALS_ACCESS_REGISTRY.md",
];
for (const rel of internalTop) {
  try {
    prepend(join(root, rel), INTERNAL, "Internal Operational Document");
  } catch {
    /* skip */
  }
}

// Supporting: start-here, external (not API_USAGE), self-host
for (const f of walkMd(join(root, "docs/start-here"))) prepend(f, SUPPORTING, "Supporting Documentation");

for (const f of walkMd(join(root, "docs/external"))) {
  if (f.replace(/\\/g, "/").endsWith("docs/external/API_USAGE.md")) continue;
  prepend(f, SUPPORTING, "Supporting Documentation");
}

for (const f of walkMd(join(root, "docs/self-host"))) prepend(f, SUPPORTING, "Supporting Documentation");

for (const f of walkMd(join(root, "examples"))) {
  if (f.endsWith("README.md")) prepend(f, SUPPORTING, "Supporting Documentation");
}

for (const rel of ["README.md", "SECURITY.md", "docs/SECURITY.md", "docs/DATA_RETENTION.md", "docs/DOCUMENTATION_INDEX.md"]) {
  try {
    prepend(join(root, rel), SUPPORTING, "Supporting Documentation");
  } catch {
    /* skip */
  }
}

for (const rel of ["packages/mcp-server/README.md", "packages/cli/README.md", "bruno/MemoryNode/README.md", "public-onboarding/README.md"]) {
  try {
    prepend(join(root, rel), SUPPORTING, "Supporting Documentation");
  } catch {
    /* skip */
  }
}

console.log("apply_doc_banners: done.");
