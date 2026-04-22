#!/usr/bin/env node
/**
 * Idempotent governance banners (run: node scripts/apply_doc_banners.mjs).
 * Trimmed to the post-cleanup kept tree:
 *   Root:           README.md, docs/SECURITY.md
 *   Truth docs:     docs/external/API_USAGE.md, docs/external/openapi.yaml, docs/MCP_SERVER.md,
 *                   packages/sdk/README.md
 *   Operator docs:  docs/PROD_SETUP_CHECKLIST.md, docs/internal/*.md
 *   Observability:  docs/observability/alert_rules.json, slo_targets.json (JSON, no banner)
 *
 * Truth docs are intentionally left banner-free. Internal operator docs receive the
 * "Internal Operational Document" banner. Root README and SECURITY receive the
 * "Supporting Documentation" banner.
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

// Internal operator docs — the full kept docs/internal tree.
for (const f of walkMd(join(root, "docs/internal"))) {
  prepend(f, INTERNAL, "Internal Operational Document");
}

// Operator docs at docs/ root that are not truth docs.
for (const rel of ["docs/PROD_SETUP_CHECKLIST.md"]) {
  try {
    prepend(join(root, rel), INTERNAL, "Internal Operational Document");
  } catch {
    /* skip */
  }
}

// App operational READMEs (still present; not under docs/).
for (const rel of ["apps/api/README.md", "apps/dashboard/README.md"]) {
  try {
    prepend(join(root, rel), INTERNAL, "Internal Operational Document");
  } catch {
    /* skip */
  }
}

// Supporting banner for repo-root README and docs/SECURITY.md.
for (const rel of ["README.md", "docs/SECURITY.md"]) {
  try {
    prepend(join(root, rel), SUPPORTING, "Supporting Documentation");
  } catch {
    /* skip */
  }
}

// Supporting banner for out-of-docs helper READMEs that still ship.
for (const rel of ["packages/mcp-server/README.md", "packages/cli/README.md"]) {
  try {
    prepend(join(root, rel), SUPPORTING, "Supporting Documentation");
  } catch {
    /* skip */
  }
}

console.log("apply_doc_banners: done.");
