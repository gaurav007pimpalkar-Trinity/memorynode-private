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
      attempts: { type: "string" },
      "delay-ms": { type: "string" },
      "require-expected-sha": { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });
  const expectedSha = (values["expected-sha"] ?? process.env.VITE_BUILD_SHA ?? "").trim();
  const consoleOrigin = stripTrailingSlash(values["console-origin"] ?? process.env.DASHBOARD_VERIFY_CONSOLE_ORIGIN ?? DEFAULT_CONSOLE);
  const appOrigin = stripTrailingSlash(values["app-origin"] ?? process.env.DASHBOARD_VERIFY_APP_ORIGIN ?? DEFAULT_APP);
  const attemptsRaw = values.attempts ?? process.env.VERIFY_PAGES_ATTEMPTS ?? "8";
  const delayRaw = values["delay-ms"] ?? process.env.VERIFY_PAGES_DELAY_MS ?? "4000";
  const maxAttempts = Math.max(1, Math.min(60, parseInt(attemptsRaw, 10) || 8));
  const delayMs = Math.max(500, Math.min(120000, parseInt(delayRaw, 10) || 4000));
  const requireExpectedRaw = `${values["require-expected-sha"] ?? process.env.VERIFY_PAGES_REQUIRE_EXPECTED_SHA ?? "1"}`
    .trim()
    .toLowerCase();
  const requireExpectedSha = !["0", "false", "off", "no"].includes(requireExpectedRaw);
  return { expectedSha, consoleOrigin, appOrigin, maxAttempts, delayMs, requireExpectedSha };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const verifyFetchInit = {
  method: "GET",
  redirect: "follow",
  cache: "no-store",
  headers: {
    "user-agent": "memorynode-dashboard-deploy-verify/1",
    "cache-control": "no-cache",
    pragma: "no-cache",
  },
};

async function httpOk(url, label) {
  const u = `${url}${url.includes("?") ? "&" : "?"}_mn_verify=${Date.now()}`;
  const res = await fetch(u, {
    ...verifyFetchInit,
  });
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} for ${url}`);
  }
}

async function fetchVersionJson(origin) {
  const url = `${origin}/version.json?_mn_verify=${Date.now()}`;
  const res = await fetch(url, {
    ...verifyFetchInit,
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

async function verifyOnce({ expectedSha, requireExpectedSha, consoleOrigin, appOrigin }) {
  await httpOk(consoleOrigin + "/", "console home");
  await httpOk(`${appOrigin}/founder`, "app founder");

  const c = await fetchVersionJson(consoleOrigin);
  const a = await fetchVersionJson(appOrigin);

  if (c.gitSha !== a.gitSha) {
    throw new Error(`version mismatch: console gitSha=${c.gitSha} app gitSha=${a.gitSha}`);
  }
  if (requireExpectedSha && expectedSha && c.gitSha !== expectedSha) {
    throw new Error(`version mismatch: live gitSha=${c.gitSha} expected=${expectedSha}`);
  }
  return c.gitSha;
}

export async function verifyDashboardPagesDeploy(opts = {}) {
  const parsed = parseCli();
  const expectedSha = (opts.expectedSha ?? parsed.expectedSha).trim();
  const requireExpectedSha = opts.requireExpectedSha ?? parsed.requireExpectedSha;
  const consoleOrigin = opts.consoleOrigin ?? parsed.consoleOrigin;
  const appOrigin = opts.appOrigin ?? parsed.appOrigin;
  const maxAttempts = opts.maxAttempts ?? parsed.maxAttempts;
  const delayMs = opts.delayMs ?? parsed.delayMs;

  let lastErr = /** @type {Error | null} */ (null);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const liveSha = await verifyOnce({ expectedSha, requireExpectedSha, consoleOrigin, appOrigin });
      console.log(
        `[verify_dashboard_pages_deploy] OK (attempt ${attempt}/${maxAttempts}) console=${consoleOrigin} app=${appOrigin} gitSha=${liveSha}` +
          (requireExpectedSha ? "" : " (expected SHA check disabled)"),
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
