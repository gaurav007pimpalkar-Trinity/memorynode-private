import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TABLES = new Set([
  "memories",
  "memory_chunks",
  "usage_daily",
  "usage_daily_v2",
]);

const DEFAULT_ALLOWLIST = [
  // Import paths insert/upsert by explicit workspace_id payload construction.
  { fileIncludes: "workerApp.ts", table: "memories", op: "insert" },
  { fileIncludes: "workerApp.ts", table: "memories", op: "upsert" },
  { fileIncludes: "workerApp.ts", table: "memory_chunks", op: "insert" },
  { fileIncludes: "workerApp.ts", table: "memory_chunks", op: "upsert" },
  // Memory extraction child inserts include workspace_id in payload.
  { fileIncludes: "handlers/memories.ts", table: "memory_chunks", op: "insert" },
  // Cost guard reads global aggregate for budget checks.
  { fileIncludes: "costGuard.ts", table: "usage_daily", op: "select" },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

export function scanWorkspaceScopeViolations({
  files,
  tables = DEFAULT_TABLES,
  allowlist = DEFAULT_ALLOWLIST,
}) {
  const violations = [];
  const fromRegex = /\.from\("([a-zA-Z0-9_]+)"\)\s*\.(select|update|delete|insert|upsert)\(/g;

  for (const file of files) {
    const normalizedFile = file.replace(/\\/g, "/");
    const content = readFileSync(file, "utf8");
    let match;
    while ((match = fromRegex.exec(content)) !== null) {
      const table = match[1];
      const op = match[2];
      if (!tables.has(table)) continue;
      if (allowlist.some((rule) => normalizedFile.includes(rule.fileIncludes) && rule.table === table && rule.op === op)) {
        continue;
      }

      const start = match.index;
      const end = content.indexOf(";", start);
      const segment = content.slice(start, end >= 0 ? end : Math.min(start + 800, content.length));

      const hasWorkspaceEq = /\.eq\("workspace_id"/.test(segment);
      const hasWorkspaceRpcArg = /p_workspace_id/.test(segment);
      const writesWorkspaceField = /\bworkspace_id\s*:/.test(segment);

      const allowed =
        op === "select" || op === "update" || op === "delete"
          ? hasWorkspaceEq || hasWorkspaceRpcArg
          : writesWorkspaceField;

      if (!allowed) {
        const line = content.slice(0, start).split("\n").length;
        violations.push({
          file,
          line,
          table,
          op,
          message: `Missing workspace scope on ${table}.${op}`,
        });
      }
    }
  }

  return violations;
}

export function defaultApiSourceFiles(repoRoot) {
  const srcDir = join(repoRoot, "apps", "api", "src");
  return walk(srcDir);
}
