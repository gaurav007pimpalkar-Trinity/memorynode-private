#!/usr/bin/env node
/**
 * Preflight: validate env for local API dev (reads apps/api/.dev.vars if present).
 * Groups keys so solo devs see "required" vs "optional" at a glance.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const devVarsPath = path.join(root, "apps", "api", ".dev.vars");

/** Minimum keys for Wrangler to boot the Worker against Supabase (stub embeddings). */
const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "API_KEY_SALT", "MASTER_ADMIN_TOKEN"];

/** Nice to have for real search quality / extraction locally. */
const OPTIONAL = [
  "OPENAI_API_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_JWT_SECRET",
  "EMBEDDINGS_MODE",
  "PAYU_MERCHANT_KEY",
];

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
    console.warn("See apps/api/.env.local.example for the shortest checklist.");
  }

  const missingRequired = REQUIRED.filter((k) => !vars[k] || vars[k] === "");
  const missingOptional = OPTIONAL.filter((k) => !vars[k] || vars[k] === "");

  if (missingRequired.length) {
    console.error("Preflight — required (local API will not behave without these):");
    for (const k of missingRequired) console.error(`  - ${k}`);
    process.exit(1);
  }

  if (missingOptional.length) {
    console.warn("Preflight — optional (fill when you need the feature):");
    for (const k of missingOptional) console.warn(`  - ${k}`);
  }

  const mode = (vars.EMBEDDINGS_MODE ?? "").toLowerCase();
  if (mode === "stub" || mode === "") {
    console.log("Preflight: ok (stub or unset EMBEDDINGS_MODE — cheapest local loop)");
  } else {
    console.log("Preflight: ok (EMBEDDINGS_MODE=%s — uses OpenAI when keys are set)", vars.EMBEDDINGS_MODE ?? "");
  }
  process.exit(0);
}

main();
