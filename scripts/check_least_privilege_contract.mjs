#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const requiredFiles = [
  path.join(root, "infra", "sql", "047_workspace_scoped_memory_rpcs.sql"),
  path.join(root, "infra", "sql", "048_list_memories_scoped_rpc.sql"),
  path.join(root, "infra", "sql", "049_request_path_rls_first.sql"),
  path.join(root, "docs", "internal", "LEAST_PRIVILEGE_ROADMAP.md"),
];

for (const file of requiredFiles) {
  if (!existsSync(file)) {
    console.error(`least-privilege contract failed: missing ${file}`);
    process.exit(1);
  }
}

const roadmap = readFileSync(path.join(root, "docs", "internal", "LEAST_PRIVILEGE_ROADMAP.md"), "utf8");
if (!roadmap.includes("rls-first")) {
  console.error("least-privilege contract failed: roadmap must define rls-first target");
  process.exit(1);
}

const rlsFirstMigration = readFileSync(path.join(root, "infra", "sql", "049_request_path_rls_first.sql"), "utf8");
const requiredSnippets = [
  "force row level security",
  "authenticate_api_key",
  "touch_api_key_usage",
  "workspace_members_self_insert",
  "is_workspace_member",
];
for (const snippet of requiredSnippets) {
  if (!rlsFirstMigration.toLowerCase().includes(snippet.toLowerCase())) {
    console.error(`least-privilege contract failed: 049_request_path_rls_first.sql missing "${snippet}"`);
    process.exit(1);
  }
}

console.log("least-privilege contract check passed.");
