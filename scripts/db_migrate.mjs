#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "pg";

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL (or DATABASE_URL) environment variable.");
  process.exit(1);
}

const migrationsDir = path.resolve("infra/sql");
const migrationTable = "memorynode_migrations";

function listMigrations() {
  const files = fs.readdirSync(migrationsDir);
  return files
    .filter((f) => /^\d+_.*\.sql$/.test(f) && f !== "verify_rls.sql")
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

async function ensureTable(client) {
  await client.query(`
    create table if not exists ${migrationTable} (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function applyMigration(client, filename) {
  const fullPath = path.join(migrationsDir, filename);
  const sql = fs.readFileSync(fullPath, "utf8");
  const checksum = sha256(sql);

  const existing = await client.query(
    `select checksum from ${migrationTable} where filename = $1`,
    [filename],
  );

  if (existing.rows.length) {
    const stored = existing.rows[0].checksum;
    if (stored !== checksum) {
      throw new Error(
        `Checksum drift detected for ${filename}. Expected ${stored} but found ${checksum}.`,
      );
    }
    console.log(`SKIP  ${filename} (already applied)`);
    return;
  }

  console.log(`APPLY ${filename}`);
  await client.query(sql);
  await client.query(
    `insert into ${migrationTable} (filename, checksum) values ($1, $2)`,
    [filename, checksum],
  );
}

async function main() {
  const client = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    await ensureTable(client);
    const migrations = listMigrations();
    for (const file of migrations) {
      await applyMigration(client, file);
    }
    console.log("All migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
