#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanWorkspaceScopeViolations, defaultApiSourceFiles } from "./lib/workspace_scope_guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const allowlistPath = path.join(root, "scripts", "security", "service_role_allowlist.json");

const allowlistJson = JSON.parse(readFileSync(allowlistPath, "utf8"));
const allowedServiceRoleFiles = new Set(
  (allowlistJson.allowed_files ?? []).map((file) => file.replace(/\\/g, "/")),
);

const files = defaultApiSourceFiles(root);
const violations = [];

const tenantTables = new Set([
  "memories",
  "memory_chunks",
  "usage_daily",
  "usage_daily_v2",
  "search_query_history",
  "workspace_members",
  "workspace_entitlements",
  "payu_transactions",
  "api_keys",
  "workspaces",
  "api_audit_log",
]);

for (const file of files) {
  const normalized = file.replace(/\\/g, "/");
  const content = readFileSync(file, "utf8");
  const hasServiceRoleClientCreation =
    /createClient\([\s\S]*SUPABASE_SERVICE_ROLE_KEY/.test(content);
  if (hasServiceRoleClientCreation) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (!allowedServiceRoleFiles.has(rel)) {
      violations.push(
        `${normalized}: service-role createClient usage must be allowlisted in scripts/security/service_role_allowlist.json`,
      );
    }
  }
  if (
    content.includes("fall back to query path for compatibility during migration rollout")
  ) {
    violations.push(`${normalized}: fallback-to-direct query marker is forbidden`);
  }
}

const scopeViolations = scanWorkspaceScopeViolations({
  files,
  tables: tenantTables,
  allowlist: [
    { fileIncludes: "workerApp.ts", table: "memories", op: "insert" },
    { fileIncludes: "workerApp.ts", table: "memories", op: "upsert" },
    { fileIncludes: "workerApp.ts", table: "memory_chunks", op: "insert" },
    { fileIncludes: "workerApp.ts", table: "memory_chunks", op: "upsert" },
    { fileIncludes: "handlers/memories.ts", table: "memory_chunks", op: "insert" },
    { fileIncludes: "costGuard.ts", table: "usage_daily", op: "select" },
    { fileIncludes: "auth.ts", table: "workspaces", op: "select" },
    { fileIncludes: "auth.ts", table: "api_keys", op: "select" },
    { fileIncludes: "handlers/admin.ts", table: "workspaces", op: "select" },
    { fileIncludes: "handlers/admin.ts", table: "payu_transactions", op: "select" },
    { fileIncludes: "handlers/apiKeys.ts", table: "api_keys", op: "update" },
    { fileIncludes: "handlers/billing.ts", table: "workspaces", op: "select" },
    { fileIncludes: "handlers/billing.ts", table: "workspaces", op: "update" },
    { fileIncludes: "handlers/search.ts", table: "search_query_history", op: "select" },
    { fileIncludes: "handlers/workspaces.ts", table: "workspaces", op: "insert" },
    { fileIncludes: "usage/quotaResolution.ts", table: "workspaces", op: "select" },
    { fileIncludes: "workerApp.ts", table: "payu_transactions", op: "select" },
    { fileIncludes: "workerApp.ts", table: "payu_transactions", op: "update" },
    { fileIncludes: "workerApp.ts", table: "workspace_entitlements", op: "select" },
    { fileIncludes: "workerApp.ts", table: "workspace_entitlements", op: "update" },
    { fileIncludes: "workerApp.ts", table: "workspace_entitlements", op: "insert" },
    { fileIncludes: "workerApp.ts", table: "workspaces", op: "select" },
    { fileIncludes: "workerApp.ts", table: "workspaces", op: "update" },
    // PayU reconcile (same txn-id / webhook flows as former workerApp inline code).
    { fileIncludes: "payuReconcile.ts", table: "payu_transactions", op: "select" },
    { fileIncludes: "payuReconcile.ts", table: "payu_transactions", op: "update" },
    { fileIncludes: "payuReconcile.ts", table: "workspace_entitlements", op: "select" },
    { fileIncludes: "payuReconcile.ts", table: "workspace_entitlements", op: "update" },
    { fileIncludes: "payuReconcile.ts", table: "workspace_entitlements", op: "insert" },
    { fileIncludes: "payuReconcile.ts", table: "workspaces", op: "select" },
    { fileIncludes: "payuReconcile.ts", table: "workspaces", op: "update" },
    { fileIncludes: "handlers/auditLog.ts", table: "api_audit_log", op: "select" },
    // Dashboard bootstrap/workspace listing use user-token-scoped clients with membership joins.
    { fileIncludes: "handlers/dashboardOps.ts", table: "workspaces", op: "select" },
  ],
});
for (const v of scopeViolations) {
  violations.push(`${v.file.replace(/\\/g, "/")}:${v.line} ${v.message}`);
}

if (violations.length > 0) {
  console.error("request-path least-privilege guard failed:");
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}

console.log(`request-path least-privilege guard passed (${files.length} files checked).`);
