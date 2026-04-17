#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dashboardDir = path.join(root, "apps", "dashboard");
const srcDir = path.join(dashboardDir, "src");
const distAssetsDir = path.join(dashboardDir, "dist", "assets");
const headersPath = path.join(dashboardDir, "public", "_headers");
const vercelPath = path.join(dashboardDir, "vercel.json");
const indexHtmlPath = path.join(dashboardDir, "index.html");

let failed = false;
function fail(msg) {
  console.error(`[dashboard-quality] ${msg}`);
  failed = true;
}

function ensureSecurityHeaders() {
  const headers = readFileSync(headersPath, "utf8");
  const vercel = readFileSync(vercelPath, "utf8");
  const required = ["Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"];
  for (const key of required) {
    if (!headers.includes(key) || !vercel.includes(key)) {
      fail(`missing ${key} in dashboard header configs`);
    }
  }
  if (!headers.includes("object-src 'none'") || !vercel.includes("object-src 'none'")) {
    fail("CSP must include object-src 'none'");
  }
  if (!headers.includes("frame-ancestors 'none'") || !vercel.includes("frame-ancestors 'none'")) {
    fail("CSP must include frame-ancestors 'none'");
  }
  if (/script-src[^;\n]*unsafe-inline/i.test(headers) || /script-src[^;\n]*unsafe-inline/i.test(vercel)) {
    fail("CSP script-src must not include unsafe-inline");
  }
}

function ensureA11yContracts() {
  const html = readFileSync(indexHtmlPath, "utf8");
  if (!/<html[^>]*lang=/i.test(html)) fail("index.html must set html lang");
  if (!/<title>[^<]+<\/title>/i.test(html)) fail("index.html must set non-empty title");
  if (!/name="viewport"/i.test(html)) fail("index.html must set viewport meta");

  const entries = readdirSync(srcDir, { withFileTypes: true });
  const stack = entries.map((e) => path.join(srcDir, e.name));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const st = statSync(current);
    if (st.isDirectory()) {
      for (const e of readdirSync(current, { withFileTypes: true })) {
        stack.push(path.join(current, e.name));
      }
      continue;
    }
    if (!current.endsWith(".ts") && !current.endsWith(".tsx")) continue;
    const content = readFileSync(current, "utf8");
    if (/tabIndex\s*=\s*["'{]?[1-9]/.test(content)) {
      fail(`positive tabIndex found in ${path.relative(root, current)}`);
    }
  }
}

function ensurePerfBudget() {
  if (!existsSync(distAssetsDir)) {
    console.warn("[dashboard-quality] dist/assets not found; skipping bundle-size check (run after build).");
    return;
  }
  const jsFiles = readdirSync(distAssetsDir).filter((name) => name.endsWith(".js"));
  const totalBytes = jsFiles.reduce((sum, file) => sum + statSync(path.join(distAssetsDir, file)).size, 0);
  const maxBytes = 700 * 1024; // 700 KB uncompressed JS budget
  if (totalBytes > maxBytes) {
    fail(`dashboard JS bundle too large (${totalBytes} bytes > ${maxBytes})`);
  }
}

try {
  ensureSecurityHeaders();
  ensureA11yContracts();
  ensurePerfBudget();
} catch (err) {
  fail((err && err.message) || String(err));
}

if (failed) process.exit(1);
console.log("dashboard quality checks passed.");
