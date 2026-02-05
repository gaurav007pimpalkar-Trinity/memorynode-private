#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const filePath = path.resolve("apps/api/wrangler.toml");
if (!fs.existsSync(filePath)) {
  console.error(`wrangler.toml not found at ${filePath}`);
  process.exit(1);
}

const raw = fs.readFileSync(filePath, "utf8");

const hasBinding =
  /\{\s*name\s*=\s*"RATE_LIMIT_DO"\s*,\s*class_name\s*=\s*"RateLimitDO"\s*\}/s.test(raw);

const hasMigration =
  /\[\[migrations\]\][\s\S]*?RateLimitDO/i.test(raw);

if (!hasBinding) {
  console.error(
    'Missing Durable Object binding: expected { name = "RATE_LIMIT_DO", class_name = "RateLimitDO" } in [durable_objects].',
  );
  process.exit(1);
}

if (!hasMigration) {
  console.error(
    "Missing Durable Object migration tag for RateLimitDO (e.g., [[migrations]] with new_sqlite_classes = [\"RateLimitDO\"]).",
  );
  process.exit(1);
}

console.log("wrangler.toml has RATE_LIMIT_DO binding and migration.");
