#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL (or DATABASE_URL) environment variable.");
  process.exit(1);
}

const verifyPath = path.resolve("infra/sql/verify_rls.sql");
if (!fs.existsSync(verifyPath)) {
  console.error("verify_rls.sql not found at infra/sql/verify_rls.sql");
  process.exit(1);
}

const sql = fs.readFileSync(verifyPath, "utf8");

async function main() {
  const client = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    const res = await client.query(sql);
    const rows = res?.rows ?? [];

    const hasViolations =
      rows.length > 0 ||
      rows.some((row) => JSON.stringify(row).match(/fail|error/i));

    if (hasViolations) {
      console.error("RLS verification failed; violations returned:");
      console.error(JSON.stringify(rows, null, 2));
      process.exit(1);
    }

    console.log("RLS verification passed (no violations returned).");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
