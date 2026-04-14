#!/usr/bin/env node
/**
 * Live staging smoke: hits deployed Worker (not local).
 * Steps: health -> 2x ingest -> search -> context -> usage.
 * Env order: STAGING_BASE_URL or BASE_URL; STAGING_API_KEY or MEMORYNODE_API_KEY.
 * Optionally load .env.staging.smoke then .env.gate (if present).
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
  console.log(`[smoke] loaded ${path}`);
}

function requireEnv(names) {
  for (const n of names) {
    const val = process.env[n];
    if (val && String(val).trim() !== "") return val.trim();
  }
  throw new Error(`Missing required env var (provide one of): ${names.join(", ")}`);
}

async function req(baseUrl, path, init = {}) {
  const url = new URL(path, baseUrl).toString();
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore parse errors */
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${path} body=${text.slice(0, 300)}`);
  }
  return { res, text, json };
}

async function main() {
  const runId = "staging-smoke";
  const stagingEnvPath = ".env.staging.smoke";
  const gateEnvPath = ".env.gate";
  const hasStagingEnvFile = fs.existsSync(stagingEnvPath);
  const hasGateEnvFile = fs.existsSync(gateEnvPath);
  loadEnvFile(stagingEnvPath);
  loadEnvFile(gateEnvPath);

  // #region agent log
  await debugLog(runId, "H1", "scripts/smoke_staging.mjs:72", "smoke env preflight", {
    hasStagingEnvFile,
    hasGateEnvFile,
    hasStagingBaseUrl: Boolean(process.env.STAGING_BASE_URL),
    hasBaseUrl: Boolean(process.env.BASE_URL),
    hasStagingApiKey: Boolean(process.env.STAGING_API_KEY),
    hasMemoryNodeApiKey: Boolean(process.env.MEMORYNODE_API_KEY),
  });
  // #endregion

  const baseUrl = requireEnv(["STAGING_BASE_URL", "BASE_URL"]);
  const apiKey = requireEnv(["STAGING_API_KEY", "MEMORYNODE_API_KEY"]);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  const suffix = Date.now();
  const namespace = "smoke";
  const user = "smoke-user";
  const text1 = `smoke check one ${suffix}`;
  const text2 = `smoke check two ${suffix}`;

  // #region agent log
  await debugLog(runId, "H1", "scripts/smoke_staging.mjs:82", "staging smoke initialized", {
    baseUrlHost: new URL(baseUrl).host,
    namespace,
    user,
  });
  // #endregion

  console.log("[smoke] GET /healthz");
  await req(baseUrl, "/healthz");

  console.log("[smoke] POST /v1/memories #1");
  await req(baseUrl, "/v1/memories", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: user, namespace, text: text1 }),
  });

  console.log("[smoke] POST /v1/memories #2");
  await req(baseUrl, "/v1/memories", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: user, namespace, text: text2 }),
  });

  console.log("[smoke] POST /v1/search");
  const search = await req(baseUrl, "/v1/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: user, namespace, query: "smoke check", top_k: 5 }),
  });
  const hits = Array.isArray(search.json?.results) ? search.json.results.length : 0;
  // #region agent log
  await debugLog(runId, "H2", "scripts/smoke_staging.mjs:107", "api search response observed", {
    hits,
    hasResultsArray: Array.isArray(search.json?.results),
  });
  // #endregion
  if (hits < 1) throw new Error("Search returned 0 results");

  console.log("[smoke] POST /v1/context");
  const ctx = await req(baseUrl, "/v1/context", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: user, namespace, query: "smoke check", top_k: 5 }),
  });
  if (!ctx.json?.context_text || String(ctx.json.context_text).trim() === "") {
    throw new Error("Context response missing context_text");
  }

  console.log("[smoke] GET /v1/usage/today");
  await req(baseUrl, "/v1/usage/today", { headers: { authorization: `Bearer ${apiKey}` } });

  // #region agent log
  await debugLog(runId, "H4", "scripts/smoke_staging.mjs:125", "staging smoke completed", {
    passed: true,
    endpointCount: 6,
  });
  // #endregion

  console.log("✅ staging smoke passed");
}

main().catch(async (err) => {
  // #region agent log
  await debugLog("staging-smoke", "H1", "scripts/smoke_staging.mjs:136", "staging smoke failed", {
    errorMessage: err instanceof Error ? err.message : String(err),
  });
  // #endregion
  console.error("❌ staging smoke failed:", err.message);
  process.exitCode = 1;
});
