#!/usr/bin/env node
/**
 * Hard CI gates for Phase 0.
 * G1: No dash-user in dashboard (or API used by dashboard).
 * G2: localStorage/sessionStorage keys must match allowlist (no surprise key names; values not inspected here).
 * G3: Prod build requires VITE_API_BASE_URL (enforced by Vite plugin; this step asserts build fails when unset).
 * G3b: Prod build requires VITE_APP_SURFACE=console|app (enforced by Vite plugin; asserts build fails when unset).
 */

import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = join(__dirname, "..");
const dashboardSrc = join(root, "apps", "dashboard", "src");
const dashboardRoot = join(root, "apps", "dashboard");
const apiSrc = join(root, "apps", "api", "src");

const ALLOWED_STORAGE_KEYS = new Set([
  "theme",
  "workspace_id",
  "mn_workspace_id",
  "mn_console_surface",
  /** Last plaintext API key shown once after creation (sessionStorage only; cleared on sign-out). */
  "mn_console_last_api_key_plaintext",
  /** Command palette recent command ids (localStorage JSON array). */
  "mn_cmd_palette_recent_v2",
  /** Per-project Memory Lab subject id + scope map (localStorage JSON). */
  "memorynode.identity",
  /** Onboarding / checklist: user ran a Memory Lab search. */
  "mn_lab_search_done",
  "mn_lab_active_tab",
  "mn_lab_last_query",
  "mn_lab_last_context_q",
  "mn_lab_density",
]);
let failed = false;

function fail(msg) {
  console.error("[CI Trust Gate]", msg);
  failed = true;
}

// G1: No "dash-user" or 'dash-user' in dashboard or API
function runG1() {
  console.log("G1: Checking for dash-user...");
  const dirs = [
    { path: join(root, "apps", "dashboard"), name: "dashboard" },
    { path: join(root, "apps", "api"), name: "api" },
  ];
  for (const { path: dir, name } of dirs) {
    const files = walk(dir, (f) => f.endsWith(".tsx") || f.endsWith(".ts") || f.endsWith(".js"));
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (/["']dash-user["']/.test(content)) {
        fail(`G1 failed: "${name}" contains dash-user: ${relative(root, file)}`);
      }
    }
  }
  if (!failed) console.log("G1 passed.");
}

function walk(dir, predicate, out = []) {
  if (!dir || !exists(dir)) return out;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) {
      walk(full, predicate, out);
    } else if (e.isFile() && predicate(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function exists(p) {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}

// G2: No localStorage/sessionStorage.setItem except allowlist
function runG2() {
  console.log("G2: Checking browser storage keys against allowlist...");
  const files = walk(dashboardSrc, (f) => f.endsWith(".tsx") || f.endsWith(".ts") || f.endsWith(".js"));
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const setMatch = line.match(/localStorage\.setItem\s*\(\s*([^,)]+)/) || line.match(/sessionStorage\.setItem\s*\(\s*([^,)]+)/);
      if (setMatch) {
        const keyExpr = setMatch[1].trim();
        const resolved = resolveKey(keyExpr, content, file);
        if (resolved !== null && !ALLOWED_STORAGE_KEYS.has(resolved)) {
          fail(`G2 failed: disallowed storage key "${resolved}" in ${relative(root, file)}:${i + 1}`);
        }
      }
    }
  }
  if (!failed) console.log("G2 passed.");
}

function resolveKey(expr, content, file) {
  const trimmed = expr.trim();
  const literal = trimmed.match(/^["']([^"']+)["']$/);
  if (literal) return literal[1];
  const ident = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
  if (ident) {
    const name = ident[1];
    const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "m");
    const m = content.match(re);
    if (m) return m[1];
    fail(`G2: could not resolve storage key variable "${name}" in ${relative(root, file)}`);
    return null;
  }
  return null;
}

// G3: Assert production build fails when VITE_API_BASE_URL is unset
function runG3() {
  console.log("G3: Asserting dashboard prod build fails without VITE_API_BASE_URL...");
  try {
    execSync("pnpm run build", {
      cwd: dashboardRoot,
      env: { ...process.env, VITE_API_BASE_URL: "", VITE_APP_SURFACE: "console" },
      stdio: "pipe",
    });
    fail("G3 failed: production build succeeded without VITE_API_BASE_URL (expected failure).");
  } catch (e) {
    if (e.status === 1) {
      console.log("G3 passed (build correctly failed when VITE_API_BASE_URL unset).");
    } else {
      fail(`G3 failed: unexpected error running build: ${e.message}`);
    }
  }
}

// G3b: Assert production build fails when VITE_APP_SURFACE is unset (valid API set)
function runG3b() {
  console.log("G3b: Asserting dashboard prod build fails without VITE_APP_SURFACE...");
  const env = { ...process.env, VITE_API_BASE_URL: "https://api.memorynode.ai" };
  delete env.VITE_APP_SURFACE;
  try {
    execSync("pnpm run build", {
      cwd: dashboardRoot,
      env,
      stdio: "pipe",
    });
    fail("G3b failed: production build succeeded without VITE_APP_SURFACE (expected failure).");
  } catch (e) {
    if (e.status === 1) {
      console.log("G3b passed (build correctly failed when VITE_APP_SURFACE unset).");
    } else {
      fail(`G3b failed: unexpected error running build: ${e.message}`);
    }
  }
}

// G4: Dashboard tests must cover auth/session, workspace scoping, and key flow (no key in browser)
function runG4() {
  console.log("G4: Checking dashboard test categories (auth/session, workspace, key flow)...");
  const testsDir = join(dashboardRoot, "tests");
  if (!exists(testsDir)) {
    fail("G4 failed: apps/dashboard/tests not found.");
    return;
  }
  const testFiles = walk(testsDir, (f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"));
  let hasSession = false;
  let hasWorkspaceOrIdentity = false;
  let hasKeyFlow = false;
  for (const file of testFiles) {
    const content = readFileSync(file, "utf8");
    if (/\b(ensureDashboardSession|dashboardLogout|session)\b/.test(content)) hasSession = true;
    if (/\b(workspace|dash-user|identity|userId)\b/.test(content)) hasWorkspaceOrIdentity = true;
    if (/\b(loadApiKey|saveApiKey|key.*storage|no key)\b/i.test(content)) hasKeyFlow = true;
  }
  if (!hasSession) fail("G4 failed: no dashboard test covers auth/session flow.");
  if (!hasWorkspaceOrIdentity) fail("G4 failed: no dashboard test covers workspace scoping or identity.");
  if (!hasKeyFlow) fail("G4 failed: no dashboard test covers key flow (e.g. no key in browser).");
  if (!failed) console.log("G4 passed.");
}

// G5: Security headers config present; CSP not permissive. Optionally check live URL when G5_URL is set.
async function runG5() {
  const liveUrl = process.env.G5_URL;
  if (liveUrl) {
    console.log("G5: Checking security headers on live URL:", liveUrl);
    await runG5Live(liveUrl);
    return;
  }
  console.log("G5: Checking dashboard security headers config (CSP + X-Content-Type-Options, etc.)...");
  const headersFile = join(dashboardRoot, "public", "_headers");
  const vercelFile = join(dashboardRoot, "vercel.json");
  let content = "";
  try {
    content = readFileSync(headersFile, "utf8");
  } catch {
    try {
      const vercel = JSON.parse(readFileSync(vercelFile, "utf8"));
      const headers = vercel?.headers?.[0]?.headers ?? [];
      content = headers.map((h) => `${h.key}: ${h.value}`).join("\n");
    } catch {
      fail("G5 failed: no _headers or vercel.json with headers in apps/dashboard.");
      return;
    }
  }
  assertG5Headers(content);
  if (!failed) console.log("G5 passed.");
}

function assertG5Headers(headerText) {
  const cspMatch = headerText.match(/Content-Security-Policy[:\s]+([^\n]+)/i);
  if (!cspMatch) {
    fail("G5 failed: Content-Security-Policy header not found.");
    return;
  }
  const csp = cspMatch[1];
  if (/script-src\s+['"]?\*['"]?/.test(csp)) {
    fail("G5 failed: CSP script-src must not use *.");
  }
  if (/script-src[^;]*unsafe-inline/.test(csp)) {
    fail("G5 failed: CSP script-src must not use unsafe-inline (exception only with doc in SECURITY.md).");
  }
  if (!/X-Content-Type-Options/i.test(headerText)) {
    fail("G5 failed: X-Content-Type-Options header not found.");
  }
  if (!/Referrer-Policy/i.test(headerText)) {
    fail("G5 failed: Referrer-Policy header not found.");
  }
}

async function runG5Live(url) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    const headerLines = [];
    res.headers.forEach((v, k) => headerLines.push(`${k}: ${v}`));
    const headerText = headerLines.join("\n");
    assertG5Headers(headerText);
  } catch (e) {
    fail(`G5 failed: could not fetch ${url}: ${e.message}`);
  }
  if (!failed) console.log("G5 passed (live URL).");
}

async function main() {
  runG1();
  runG2();
  runG3();
  runG3b();
  runG4();
  await runG5();
  process.exit(failed ? 1 : 0);
}
main();
