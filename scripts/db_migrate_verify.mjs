#!/usr/bin/env node
/**
 * Read-only migration verification: checks that all migration files in infra/sql
 * are applied in the target database. Use before deploy to ensure DB is up to date.
 * Does not apply any migrations.
 *
 * Usage:
 *   SUPABASE_DB_URL=postgresql://... node scripts/db_migrate_verify.mjs
 *   DATABASE_URL=postgresql://... node scripts/db_migrate_verify.mjs
 *
 * Exit 0 if all applied; exit 1 if any missing (prints missing list).
 */

import { Client } from "pg";
import { listMigrationFiles } from "./lib/migrations_manifest.mjs";

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function validateDbUrl(raw) {
  if (!raw) {
    fail("Missing SUPABASE_DB_URL (or DATABASE_URL). Set one to verify the database.");
  }
  const rawLower = raw.toLowerCase();
  if (
    rawLower.includes("your_") ||
    rawLower.includes("replace_me") ||
    rawLower.includes("changeme")
  ) {
    fail("DATABASE_URL looks like a placeholder. Set a real Postgres URL.");
  }
  return raw;
}

async function main() {
  const url = validateDbUrl(dbUrl);
  const client = new Client({
    connectionString: url,
    ssl: url.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    const expected = listMigrationFiles();
    const tableExists = await client.query(`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'memorynode_migrations'
      )
    `);
    if (!tableExists.rows[0]?.exists) {
      console.error("Table memorynode_migrations does not exist. Run pnpm db:migrate first.");
      process.exit(1);
    }
    const applied = await client.query(
      "select filename from memorynode_migrations order by filename",
    );
    const appliedSet = new Set(applied.rows.map((r) => r.filename));
    const missing = expected.filter((f) => !appliedSet.has(f));
    if (missing.length > 0) {
      console.error("Missing migrations (run pnpm db:migrate to apply):");
      missing.forEach((f) => console.error(`  - ${f}`));
      process.exit(1);
    }
    console.log(`OK: all ${expected.length} migrations applied.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
