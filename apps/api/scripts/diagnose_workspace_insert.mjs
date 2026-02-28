#!/usr/bin/env node
/**
 * Diagnose workspace insert: uses the same Supabase client as the Worker to try
 * inserting a workspace row. Run with the same env as production (SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY) to see the exact error when create workspace fails.
 *
 * From repo root (PowerShell):
 *   $env:SUPABASE_URL="https://xxx.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="eyJ..."; pnpm --filter @memorynode/api run diagnose:workspace
 *
 * From apps/api:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm run diagnose:workspace
 *
 * If you see "Invalid API key" or "JWT expired", the SERVICE_ROLE_KEY is wrong
 * or from a different project than SUPABASE_URL. Get both from Supabase Dashboard
 * → Project Settings → API (URL + service_role secret).
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Set both to the same project's values (Dashboard → Settings → API).");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  console.log("Attempting workspaces insert (name: diagnostic-test)...");
  const { data, error } = await supabase
    .from("workspaces")
    .insert({ name: "diagnostic-test" })
    .select("id, name")
    .single();

  if (error) {
    console.error("Insert failed.");
    console.error("Message:", error.message);
    if (error.code) console.error("Code:", error.code);
    if (error.details) console.error("Details:", error.details);
    if (error.hint) console.error("Hint:", error.hint);
    console.error("\nCommon cause: SUPABASE_SERVICE_ROLE_KEY is the anon key, or from a different project than SUPABASE_URL.");
    process.exit(1);
  }

  console.log("OK. Row created:", data);
  process.exit(0);
}

main();
