#!/usr/bin/env node
/**
 * Docs drift guard: externally visible behavior changes must update source-of-truth docs (same diff).
 *
 * Truth docs:
 *   docs/external/API_USAGE.md
 *   docs/external/openapi.yaml
 *   packages/sdk/README.md
 *   docs/MCP_SERVER.md
 *
 * Escape hatch (CI / local): DOCS_DRIFT_ALLOW=1 — logs prominently; set PR_BODY in CI for audit trail.
 * Optional: DOCS_DRIFT_STRICT=0 disables heuristic scan on source diffs (avoid in CI).
 * Optional: DOCS_DRIFT_LARGE_THRESHOLD=10 (0 disables) — fail if this many files changed with no truth doc.
 */

import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const TRUTH = {
  API_USAGE: "docs/external/API_USAGE.md",
  OPENAPI: "docs/external/openapi.yaml",
  SDK_README: "packages/sdk/README.md",
  MCP_SERVER: "docs/MCP_SERVER.md",
};

const ALL_TRUTH = Object.values(TRUTH);

/** Routes & hosted paths */
const RE_HTTP_SURFACE =
  /\/v1\/|\/admin\/|pathname\s*===|pathname\.startsWith\(|new\s+URLPattern|\/mcp\b/i;
/** MCP registrations / transport */
const RE_MCP_SURFACE =
  /\b(McpServer|registerTool|\.tool\s*\(|WebStandardStreamableHTTPServerTransport|\/v1\/mcp)\b/i;
/** Named tool / schema surfaces */
const RE_MCP_TOOL_OR_SCHEMA =
  /(?:tool|name)\s*:\s*["'][^"'\n]+["']|inputSchema\s*:|outputSchema\s*:|parameters\s*:\s*\{/i;
/** Response JSON shapes (surface-prone paths only) */
const RE_RESPONSE_SHAPE =
  /Response\.json\b|new\s+Response\s*\(|content-type:\s*["']application\/json/i;
/** Shared package: exported contracts */
const RE_SHARED_SURFACE =
  /^\s*export\s+(type|interface|const|enum|function|class)\s+/m;

function norm(p) {
  return p.replace(/\\/g, "/");
}

function basename(f) {
  return path.basename(f);
}

function getDiffRange() {
  const baseSha = process.env.DOCS_DRIFT_BASE_SHA?.trim();
  const headSha = process.env.DOCS_DRIFT_HEAD_SHA?.trim();
  if (baseSha && headSha) {
    if (/^0+$/.test(baseSha)) return null;
    return { base: baseSha, head: headSha };
  }
  try {
    const mb = execSync("git merge-base HEAD origin/main", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { base: mb, head: "HEAD" };
  } catch {
    try {
      return { base: "HEAD~1", head: "HEAD" };
    } catch {
      return null;
    }
  }
}

function listChangedFiles(range) {
  if (!range) return [];
  try {
    const out = execSync(`git diff --name-only ${range.base} ${range.head}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.split("\n").map(norm).filter(Boolean);
  } catch {
    return [];
  }
}

function gitDiffPaths(range, pathspecs) {
  if (!range || pathspecs.length === 0) return "";
  try {
    return execFileSync("git", ["diff", range.base, range.head, "--", ...pathspecs], {
      encoding: "utf8",
      maxBuffer: 25 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function isTestPath(f) {
  return (
    f.includes("/tests/") ||
    f.includes("__tests__/") ||
    /\.(test|spec)\.(tsx?|mts|cts|jsx?)$/i.test(f)
  );
}

/** Dashboard static assets — unlikely to need API doc updates */
function isDashboardStaticAsset(f) {
  if (!f.startsWith("apps/dashboard/")) return false;
  return /\.(png|jpe?g|webp|gif|ico|svg|woff2?|ttf|eot|mp4|webm)$/i.test(f);
}

function isLockfilePath(f) {
  const b = basename(f).toLowerCase();
  return b === "pnpm-lock.yaml" || b === "package-lock.json" || b === "yarn.lock";
}

/**
 * Large-PR gate counts meaningful product/code churn (not internal docs-only batches or lockfiles).
 */
function countsTowardLargePr(f) {
  if (isLockfilePath(f)) return false;
  if (f.startsWith("docs/")) return false;
  return true;
}

function countForLargePrGate(files) {
  return files.filter(countsTowardLargePr).length;
}

function anyTruthDocTouched(changedSet) {
  return ALL_TRUTH.some((p) => changedSet.has(p));
}

function shouldScanStrictPath(file) {
  if (file.includes("/tests/") || /\.(test|spec)\.(tsx?|mts)$/i.test(file)) return false;
  if (file.startsWith("apps/api/src/") || file.startsWith("packages/mcp-server/")) {
    return /\.(ts|tsx|mts)$/i.test(file);
  }
  if (file.startsWith("packages/shared/")) {
    return /\.(ts|tsx|mts)$/i.test(file);
  }
  return false;
}

function isSurfaceProneApiPath(file) {
  if (!file.startsWith("apps/api/src/")) return false;
  return (
    file.includes("/handlers/") ||
    file.includes("/middleware/") ||
    file.includes("/contracts/") ||
    file.endsWith("/router.ts") ||
    file.endsWith("/workerApp.ts") ||
    file.endsWith("/mcpHosted.ts") ||
    file.endsWith("/mcpCache.ts")
  );
}

function isMcpPackagePath(file) {
  return file.startsWith("packages/mcp-server/");
}

function isSharedSrcPath(file) {
  return file.startsWith("packages/shared/") && /\.(ts|mts|tsx)$/i.test(file);
}

function collectAddedLinesByFile(diffText) {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  let currentPath = null;
  for (const raw of diffText.split("\n")) {
    const m = raw.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (m) {
      currentPath = norm(m[2]);
      continue;
    }
    if (!currentPath || !shouldScanStrictPath(currentPath)) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const line = raw.slice(1);
      const arr = map.get(currentPath) ?? [];
      arr.push(line);
      map.set(currentPath, arr);
    }
  }
  return map;
}

function analyzeStrictDiff(range, changedFiles) {
  const strictEnabled = process.env.DOCS_DRIFT_STRICT !== "0";
  const out = {
    strictHttp: false,
    strictMcp: false,
    strictShared: false,
    newExternalSurface: false,
  };
  if (!strictEnabled || !range) return out;

  const needDiff = changedFiles.some(
    (f) =>
      f.startsWith("apps/api/src/") ||
      f.startsWith("packages/mcp-server/") ||
      f.startsWith("packages/shared/"),
  );
  if (!needDiff) return out;

  const diffText = gitDiffPaths(range, [
    "apps/api/src",
    "packages/mcp-server",
    "packages/shared",
  ]);
  const byFile = collectAddedLinesByFile(diffText);

  for (const [filePath, lines] of byFile) {
    const prone = isSurfaceProneApiPath(filePath) || isMcpPackagePath(filePath);
    const sharedFile = isSharedSrcPath(filePath);

    for (const line of lines) {
      const httpHit = RE_HTTP_SURFACE.test(line);
      const mcpHit =
        RE_MCP_SURFACE.test(line) || RE_MCP_TOOL_OR_SCHEMA.test(line);
      const respHit = prone && RE_RESPONSE_SHAPE.test(line);
      const sharedHit = sharedFile && RE_SHARED_SURFACE.test(line);

      if (httpHit || respHit) out.strictHttp = true;
      if (mcpHit) out.strictMcp = true;
      if (sharedHit || (sharedFile && RE_MCP_TOOL_OR_SCHEMA.test(line))) out.strictShared = true;
      if (httpHit || mcpHit || (sharedFile && sharedHit)) out.newExternalSurface = true;
    }
  }

  return out;
}

function isWranglerToml(f) {
  return /(^|\/)wrangler\.toml$/i.test(f);
}

function isWorkersToml(f) {
  return /(^|\/)workers\.toml$/i.test(f);
}

function isFallbackScopedFile(f) {
  if (isTestPath(f)) return false;
  if (
    f.startsWith("apps/api/src/") ||
    f.startsWith("packages/mcp-server/") ||
    f.startsWith("packages/shared/")
  ) {
    return true;
  }
  return false;
}

function buildRequirements(changedFiles, h) {
  let needHttpTruth = false;
  let needSdkReadme = false;
  let needMcpTruth = false;
  let needWorkerTruth = false;
  let needDashboardTruth = false;
  let needSharedTruth = false;
  let needInfraTruth = false;
  let needEntryTruth = false;

  for (const f of changedFiles) {
    if (isTestPath(f)) continue;

    if (f === "apps/api/src/router.ts") needHttpTruth = true;
    if (f.startsWith("apps/api/src/contracts/")) needHttpTruth = true;
    if (f.startsWith("apps/api/src/handlers/")) needHttpTruth = true;
    if (f.startsWith("packages/sdk/src/")) needSdkReadme = true;
    if (f.startsWith("packages/mcp-server/")) needMcpTruth = true;
    if (f === "apps/api/src/mcpHosted.ts" || f === "apps/api/src/mcpCache.ts") needMcpTruth = true;
    if (f === "apps/api/src/workerApp.ts") needWorkerTruth = true;
    if (f === "apps/api/src/index.ts") needEntryTruth = true;

    if (f.startsWith("apps/dashboard/") && !isDashboardStaticAsset(f)) needDashboardTruth = true;

    if (f.startsWith("packages/shared/") && !f.startsWith("packages/shared/node_modules/")) {
      needSharedTruth = true;
    }

    if (isWranglerToml(f) || isWorkersToml(f)) needInfraTruth = true;
  }

  if (h.strictHttp) needHttpTruth = true;
  if (h.strictMcp) needMcpTruth = true;
  if (h.strictShared) needSharedTruth = true;

  return {
    needHttpTruth,
    needSdkReadme,
    needMcpTruth,
    needWorkerTruth,
    needDashboardTruth,
    needSharedTruth,
    needInfraTruth,
    needEntryTruth,
  };
}

function truthTouches(changedSet) {
  return {
    apiUsage: changedSet.has(TRUTH.API_USAGE),
    openapi: changedSet.has(TRUTH.OPENAPI),
    sdkReadme: changedSet.has(TRUTH.SDK_README),
    mcpServer: changedSet.has(TRUTH.MCP_SERVER),
  };
}

function satisfied(t, req) {
  const {
    needHttpTruth,
    needSdkReadme,
    needMcpTruth,
    needWorkerTruth,
    needDashboardTruth,
    needSharedTruth,
    needInfraTruth,
    needEntryTruth,
  } = req;

  if (needHttpTruth && !(t.apiUsage || t.openapi)) {
    return {
      ok: false,
      code: "HTTP",
      detail:
        "HTTP routing, handlers, or contracts changed (or heuristic matched). Update docs/external/API_USAGE.md or regenerate docs/external/openapi.yaml (pnpm openapi:gen).",
    };
  }
  if (needSdkReadme && !t.sdkReadme) {
    return { ok: false, code: "SDK", detail: "SDK implementation changed. Update packages/sdk/README.md." };
  }
  if (needMcpTruth && !t.mcpServer) {
    return { ok: false, code: "MCP", detail: "MCP surface changed. Update docs/MCP_SERVER.md." };
  }
  if (needWorkerTruth && !(t.apiUsage || t.mcpServer)) {
    return {
      ok: false,
      code: "WORKER",
      detail:
        "apps/api/src/workerApp.ts changed. Update docs/external/API_USAGE.md or docs/MCP_SERVER.md (OpenAPI alone does not satisfy this rule).",
    };
  }
  if (needDashboardTruth && !(t.apiUsage || t.sdkReadme)) {
    return {
      ok: false,
      code: "DASHBOARD",
      detail:
        "Dashboard app changed. Update docs/external/API_USAGE.md or packages/sdk/README.md for user-visible behavior.",
    };
  }
  if (needSharedTruth && !(t.apiUsage || t.openapi)) {
    return {
      ok: false,
      code: "SHARED",
      detail:
        "Shared package changed. Update docs/external/API_USAGE.md or docs/external/openapi.yaml if types/contracts affect the API.",
    };
  }
  if (needInfraTruth && !t.apiUsage) {
    return {
      ok: false,
      code: "INFRA",
      detail:
        "Worker routing / infra config (wrangler.toml or workers.toml) changed. Update docs/external/API_USAGE.md for routes, bindings, or deployment expectations.",
    };
  }
  if (needEntryTruth && !t.apiUsage) {
    return {
      ok: false,
      code: "ENTRY",
      detail: "apps/api/src/index.ts (worker entry) changed. Update docs/external/API_USAGE.md for wiring/routing notes.",
    };
  }
  return { ok: true };
}

function printFailure(result, h, extra) {
  console.error("");
  console.error(
    "This change may affect external system behavior, but no documentation was updated.",
  );
  console.error("");
  console.error("Either:");
  console.error("  • Update a source-of-truth doc listed below, or");
  console.error(
    "  • Explicitly confirm this change does NOT affect external behavior — then set DOCS_DRIFT_ALLOW=1 (CI override; must be justified in the PR).",
  );
  console.error("");
  console.error("Source-of-truth documentation:");
  for (const p of ALL_TRUTH) console.error(`  - ${p}`);
  console.error("");
  if (result.detail) {
    console.error(result.detail);
    console.error("");
  }
  if (extra) {
    console.error(extra);
    console.error("");
  }
  if (h.newExternalSurface) {
    console.error(
      "Heuristic: possible new route (/v1/, /admin/), MCP tool/schema, or shared export — align docs.",
    );
    console.error("");
  }
  console.error(
    "Local false positive from heuristics: DOCS_DRIFT_STRICT=0 (do not use in CI to bypass governance).",
  );
  console.error("");
}

// --- main ---

if (process.env.DOCS_DRIFT_ALLOW === "1") {
  console.warn("");
  console.warn("check_docs_drift: DOCS_DRIFT_ALLOW=1 — enforcement bypassed for this run.");
  console.warn("Require a PR explanation for why external docs do not need updates.");
  const body = process.env.PR_BODY || "";
  if (body.trim()) {
    const excerpt = body.trim().slice(0, 600);
    console.warn("PR_BODY excerpt (set by CI on pull_request):");
    console.warn(excerpt + (body.length > 600 ? "…" : ""));
  } else {
    console.warn("(No PR_BODY env; add PR description when using override in CI.)");
  }
  console.warn("");
  process.exit(0);
}

const range = getDiffRange();
if (!range && process.env.DOCS_DRIFT_BASE_SHA?.trim() && /^0+$/.test(process.env.DOCS_DRIFT_BASE_SHA.trim())) {
  console.warn("check_docs_drift: DOCS_DRIFT_BASE_SHA is empty/zero; skipping.");
  process.exit(0);
}

if (!range) {
  console.warn("check_docs_drift: could not determine git range; skipping.");
  process.exit(0);
}

const changed = listChangedFiles(range);
if (changed.length === 0) {
  console.log("check_docs_drift: no changed files detected; OK.");
  process.exit(0);
}

const changedSet = new Set(changed);
const truthTouched = anyTruthDocTouched(changedSet);
const h = analyzeStrictDiff(range, changed);
const req = buildRequirements(changed, h);

const largeThresholdRaw = process.env.DOCS_DRIFT_LARGE_THRESHOLD;
const largeThreshold =
  largeThresholdRaw === undefined || largeThresholdRaw === ""
    ? 10
    : Number.parseInt(largeThresholdRaw, 10);
const largeCount = countForLargePrGate(changed);

function hasMappedTrigger(files, heuristic) {
  return (
    files.some((f) => {
      if (isTestPath(f)) return false;
      if (
        f === "apps/api/src/router.ts" ||
        f.startsWith("apps/api/src/contracts/") ||
        f.startsWith("apps/api/src/handlers/") ||
        f === "apps/api/src/workerApp.ts" ||
        f === "apps/api/src/mcpHosted.ts" ||
        f === "apps/api/src/mcpCache.ts" ||
        f === "apps/api/src/index.ts" ||
        f.startsWith("packages/sdk/src/") ||
        f.startsWith("packages/mcp-server/") ||
        f.startsWith("packages/shared/") ||
        (f.startsWith("apps/dashboard/") && !isDashboardStaticAsset(f)) ||
        isWranglerToml(f) ||
        isWorkersToml(f)
      ) {
        return true;
      }
      return false;
    }) ||
    heuristic.strictHttp ||
    heuristic.strictMcp ||
    heuristic.strictShared
  );
}

const anyMapped = hasMappedTrigger(changed, h);
const fallbackScoped = changed.some(isFallbackScopedFile);

if (!anyMapped && !fallbackScoped && !(largeThreshold > 0 && largeCount >= largeThreshold)) {
  console.log("check_docs_drift: no doc-governance paths matched; OK.");
  process.exit(0);
}

if (largeThreshold > 0 && largeCount >= largeThreshold && !truthTouched) {
  printFailure(
    {
      ok: false,
      detail: `Large diff (${largeCount} files, threshold ${largeThreshold}) with no truth documentation touched.`,
    },
    h,
    `Counted files exclude lockfiles (${largeCount}). Set DOCS_DRIFT_LARGE_THRESHOLD=0 to disable this gate.`,
  );
  process.exit(1);
}

if (fallbackScoped && !truthTouched) {
  printFailure(
    {
      ok: false,
      detail:
        "Fallback rule: changes under apps/api/src/, packages/mcp-server/, or packages/shared/ require at least one truth doc in the same PR.",
    },
    h,
    null,
  );
  process.exit(1);
}

const t = truthTouches(changedSet);
const result = satisfied(t, req);

if (result.ok) {
  console.log("check_docs_drift: documentation aligned with changes; OK.");
  process.exit(0);
}

printFailure(result, h, null);
process.exit(1);
