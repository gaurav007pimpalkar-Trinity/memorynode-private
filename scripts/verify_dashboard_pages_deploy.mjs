#!/usr/bin/env node
/**
 * Post-deploy checks for Cloudflare Pages (console + founder app):
 * - GET home URLs return 200
 * - GET /version.json on each origin; gitSha must match each other and optional --expected-sha / VITE_BUILD_SHA
 *
 * Retries with backoff (CDN propagation). Exit 1 on failure.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_CONSOLE = "https://console.memorynode.ai";
const DEFAULT_APP = "https://app.memorynode.ai";

function stripTrailingSlash(u) {
  return (u ?? "").trim().replace(/\/+$/, "");
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      "expected-sha": { type: "string" },
      "console-origin": { type: "string" },
      "app-origin": { type: "string" },
      attempts: { type: "string", default: "8" },
      "delay-ms": { type: "string", default: "4000" },
    },
    allowPositionals: false,
    strict: false,
  });
  const expectedSha = (values["expected-sha"] ?? process.env.VITE_BUILD_SHA ?? "").trim();
  const consoleOrigin = stripTrailingSlash(values["console-origin"] ?? process.env.DASHBOARD_VERIFY_CONSOLE_ORIGIN ?? DEFAULT_CONSOLE);
  const appOrigin = stripTrailingSlash(values["app-origin"] ?? process.env.DASHBOARD_VERIFY_APP_ORIGIN ?? DEFAULT_APP);
  const maxAttempts = Math.max(1, Math.min(30, parseInt(values.attempts ?? "8", 10) || 8));
  const delayMs = Math.max(500, Math.min(60000, parseInt(values["delay-ms"] ?? "4000", 10) || 4000));
  return { expectedSha, consoleOrigin, appOrigin, maxAttempts, delayMs };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpOk(url, label) {
  const u = `${url}${url.includes("?") ? "&" : "?"}_mn_verify=${Date.now()}`;
  const res = await fetch(u, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "memorynode-dashboard-deploy-verify/1" },
  });
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} for ${url}`);
  }
}

async function fetchVersionJson(origin) {
  const url = `${origin}/version.json?_mn_verify=${Date.now()}`;
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "memorynode-dashboard-deploy-verify/1" },
  });
  if (!res.ok) {
    throw new Error(`version.json: HTTP ${res.status} for ${origin}`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`version.json: invalid JSON from ${origin}`);
  }
  const gitSha = (data.gitSha ?? "").trim();
  if (!gitSha) {
    throw new Error(`version.json: missing gitSha from ${origin}`);
  }
  return { gitSha, surface: (data.surface ?? "").trim() };
}

async function verifyOnce({ expectedSha, consoleOrigin, appOrigin }) {
  await httpOk(consoleOrigin + "/", "console home");
  await httpOk(`${appOrigin}/founder`, "app founder");

  const c = await fetchVersionJson(consoleOrigin);
  const a = await fetchVersionJson(appOrigin);

  if (c.gitSha !== a.gitSha) {
    throw new Error(`version mismatch: console gitSha=${c.gitSha} app gitSha=${a.gitSha}`);
  }
  if (expectedSha && c.gitSha !== expectedSha) {
    throw new Error(`version mismatch: live gitSha=${c.gitSha} expected=${expectedSha}`);
  }
  return c.gitSha;
}

export async function verifyDashboardPagesDeploy(opts = {}) {
  const parsed = parseCli();
  const expectedSha = (opts.expectedSha ?? parsed.expectedSha).trim();
  const consoleOrigin = opts.consoleOrigin ?? parsed.consoleOrigin;
  const appOrigin = opts.appOrigin ?? parsed.appOrigin;
  const maxAttempts = opts.maxAttempts ?? parsed.maxAttempts;
  const delayMs = opts.delayMs ?? parsed.delayMs;

  let lastErr = /** @type {Error | null} */ (null);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const liveSha = await verifyOnce({ expectedSha, consoleOrigin, appOrigin });
      console.log(
        `[verify_dashboard_pages_deploy] OK (attempt ${attempt}/${maxAttempts}) console=${consoleOrigin} app=${appOrigin} gitSha=${liveSha}`,
      );
      return true;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`[verify_dashboard_pages_deploy] attempt ${attempt}/${maxAttempts} failed: ${lastErr.message}`);
      if (attempt < maxAttempts) await sleep(delayMs);
    }
  }
  console.error(`[verify_dashboard_pages_deploy] FAILED after ${maxAttempts} attempts: ${lastErr?.message ?? "unknown"}`);
  return false;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked && import.meta.url === invoked) {
  verifyDashboardPagesDeploy().then((ok) => process.exit(ok ? 0 : 1));
}
