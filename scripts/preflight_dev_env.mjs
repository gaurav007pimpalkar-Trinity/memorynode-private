#!/usr/bin/env node
/**
 * Preflight: print missing vars for local API dev (reads apps/api/.dev.vars if present).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const devVarsPath = path.join(root, "apps", "api", ".dev.vars");

const REQUIRED_STUB = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "API_KEY_SALT",
  "MASTER_ADMIN_TOKEN",
];

const RECOMMENDED = ["OPENAI_API_KEY"];

function parseDevVars(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

function main() {
  let vars = {};
  if (fs.existsSync(devVarsPath)) {
    vars = parseDevVars(fs.readFileSync(devVarsPath, "utf8"));
  } else {
    console.warn(`Missing ${path.relative(root, devVarsPath)} — create from apps/api/.dev.vars.template`);
  }

  const missing = REQUIRED_STUB.filter((k) => !vars[k] || vars[k] === "");
  const missingRec = RECOMMENDED.filter((k) => !vars[k] || vars[k] === "");

  if (missing.length) {
    console.error("Preflight: missing required for local API:");
    for (const k of missing) console.error(`  - ${k}`);
    process.exit(1);
  }

  if (missingRec.length) {
    console.warn("Preflight: optional (embeddings / extraction may fail without OpenAI key):");
    for (const k of missingRec) console.warn(`  - ${k}`);
  }

  const mode = (vars.EMBEDDINGS_MODE ?? "").toLowerCase();
  if (mode === "stub") {
    console.log("Preflight: ok (EMBEDDINGS_MODE=stub — minimal local)");
  } else {
    console.log("Preflight: ok (set EMBEDDINGS_MODE=stub for cheapest local iteration)");
  }
  process.exit(0);
}

main();
