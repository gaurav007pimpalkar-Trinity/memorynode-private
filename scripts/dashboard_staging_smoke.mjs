#!/usr/bin/env node
/**
 * Dashboard session smoke (staging): session login -> ingest -> search -> open memory -> usage.
 * This validates the same API flows used by dashboard UI, using cookie + CSRF auth.
 *
 * Required env:
 * - STAGING_BASE_URL or BASE_URL
 * - DASHBOARD_ACCESS_TOKEN (Supabase access token for a real dashboard user)
 * - DASHBOARD_WORKSPACE_ID (workspace the user belongs to)
 *
 * Optional env:
 * - DASHBOARD_SMOKE_USER_ID (default: smoke-dashboard-user)
 */

import fs from "node:fs";

async function debugLog(runId, hypothesisId, location, message, data) {
  await fetch("http://127.0.0.1:7420/ingest/253793e2-9a0d-4620-b251-39382727da68", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "065062" },
    body: JSON.stringify({
      sessionId: "065062",
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}

function loadEnvFile(path) {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    const v = rest.join("=");
    if (k && v && !(k in process.env)) {
      process.env[k.trim()] = v.trim();
    }
  }
  console.log(`[dashboard-smoke] loaded ${path}`);
}

function requireEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim() !== "") return value.trim();
  }
  throw new Error(`Missing required env var (provide one of): ${names.join(", ")}`);
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function mergeCookies(currentCookie, setCookieValues) {
  const jar = new Map();
  for (const part of (currentCookie ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes("=")) continue;
    const [name, ...rest] = trimmed.split("=");
    jar.set(name, rest.join("="));
  }
  for (const headerValue of setCookieValues) {
    const pair = headerValue.split(";")[0]?.trim();
    if (!pair || !pair.includes("=")) continue;
    const [name, ...rest] = pair.split("=");
    jar.set(name, rest.join("="));
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function requestJson(baseUrl, path, init = {}) {
  const url = new URL(path, baseUrl).toString();
  const response = await fetch(url, init);
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // noop
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${path} body=${raw.slice(0, 500)}`);
  }
  return { response, json, raw };
}

async function main() {
  const runId = "dashboard-smoke";
  const stagingEnvPath = ".env.staging.smoke";
  const gateEnvPath = ".env.gate";
  const hasStagingEnvFile = fs.existsSync(stagingEnvPath);
  const hasGateEnvFile = fs.existsSync(gateEnvPath);
  loadEnvFile(stagingEnvPath);
  loadEnvFile(gateEnvPath);

  // #region agent log
  await debugLog(runId, "H2", "scripts/dashboard_staging_smoke.mjs:102", "dashboard smoke env preflight", {
    hasStagingEnvFile,
    hasGateEnvFile,
    hasStagingBaseUrl: Boolean(process.env.STAGING_BASE_URL),
    hasBaseUrl: Boolean(process.env.BASE_URL),
    hasDashboardAccessToken: Boolean(process.env.DASHBOARD_ACCESS_TOKEN),
    hasDashboardWorkspaceId: Boolean(process.env.DASHBOARD_WORKSPACE_ID),
  });
  // #endregion

  const baseUrl = requireEnv(["STAGING_BASE_URL", "BASE_URL"]);
  const accessToken = requireEnv(["DASHBOARD_ACCESS_TOKEN"]);
  const workspaceId = requireEnv(["DASHBOARD_WORKSPACE_ID"]);
  const userId = (process.env.DASHBOARD_SMOKE_USER_ID ?? "smoke-dashboard-user").trim();
  const nonce = Date.now();
  const memoryText = `dashboard smoke memory ${nonce}`;

  // #region agent log
  await debugLog(runId, "H2", "scripts/dashboard_staging_smoke.mjs:101", "dashboard smoke initialized", {
    baseUrlHost: new URL(baseUrl).host,
    workspacePresent: Boolean(workspaceId),
    userId,
  });
  // #endregion

  console.log("[dashboard-smoke] GET /healthz");
  await requestJson(baseUrl, "/healthz");

  console.log("[dashboard-smoke] POST /v1/dashboard/session");
  const sessionRes = await requestJson(baseUrl, "/v1/dashboard/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_token: accessToken, workspace_id: workspaceId }),
  });
  const csrfToken = sessionRes.json?.csrf_token;
  if (!csrfToken || typeof csrfToken !== "string") {
    throw new Error("Dashboard session response missing csrf_token");
  }
  const cookie = mergeCookies("", getSetCookieValues(sessionRes.response.headers));
  // #region agent log
  await debugLog(runId, "H2", "scripts/dashboard_staging_smoke.mjs:121", "dashboard session response observed", {
    hasCsrfToken: Boolean(csrfToken),
    hasCookie: Boolean(cookie),
  });
  // #endregion
  if (!cookie) {
    throw new Error("Dashboard session response did not provide session cookie");
  }
  const sessionHeaders = {
    "content-type": "application/json",
    "x-csrf-token": csrfToken,
    cookie,
  };

  console.log("[dashboard-smoke] POST /v1/memories");
  const memoryRes = await requestJson(baseUrl, "/v1/memories", {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      user_id: userId,
      namespace: "dashboard-smoke",
      text: memoryText,
    }),
  });
  const createdMemoryId = memoryRes.json?.memory_id;
  if (!createdMemoryId || typeof createdMemoryId !== "string") {
    throw new Error("Memory create response missing memory_id");
  }

  console.log("[dashboard-smoke] POST /v1/search");
  const searchRes = await requestJson(baseUrl, "/v1/search", {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      user_id: userId,
      namespace: "dashboard-smoke",
      query: `${nonce}`,
      top_k: 5,
    }),
  });
  const results = Array.isArray(searchRes.json?.results) ? searchRes.json.results : [];
  if (results.length === 0) {
    throw new Error("Search returned no results");
  }
  const top = results[0];
  // #region agent log
  await debugLog(runId, "H3", "scripts/dashboard_staging_smoke.mjs:164", "dashboard search result shape", {
    resultCount: results.length,
    hasMemoryId: Boolean(top?.memory_id),
    hasChunkId: Boolean(top?.chunk_id),
  });
  // #endregion
  if (!top?.memory_id || !top?.chunk_id) {
    throw new Error("Search result missing memory_id/chunk_id fields");
  }

  console.log("[dashboard-smoke] GET /v1/memories/:id");
  await requestJson(baseUrl, `/v1/memories/${encodeURIComponent(top.memory_id)}`, {
    method: "GET",
    headers: { cookie },
  });

  console.log("[dashboard-smoke] GET /v1/usage/today");
  await requestJson(baseUrl, "/v1/usage/today", {
    method: "GET",
    headers: { cookie },
  });

  // #region agent log
  await debugLog(runId, "H2", "scripts/dashboard_staging_smoke.mjs:186", "dashboard smoke completed", {
    passed: true,
    createdMemoryIdPresent: Boolean(createdMemoryId),
  });
  // #endregion

  console.log(
    `✅ dashboard staging smoke passed (workspace=${workspaceId}, created_memory=${createdMemoryId}, top_hit_memory=${top.memory_id})`,
  );
}

main().catch(async (err) => {
  // #region agent log
  await debugLog("dashboard-smoke", "H2", "scripts/dashboard_staging_smoke.mjs:198", "dashboard smoke failed", {
    errorMessage: err instanceof Error ? err.message : String(err),
  });
  // #endregion
  console.error(`❌ dashboard staging smoke failed: ${err.message}`);
  process.exitCode = 1;
});
