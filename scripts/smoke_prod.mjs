#!/usr/bin/env node
/**
 * Live prod smoke: hits deployed production Worker.
 * Steps: health -> 2x ingest -> search -> context -> usage.
 * Env order:
 * - Base URL: PROD_BASE_URL or BASE_URL
 * - API key: MEMORYNODE_SMOKE_API_KEY or PROD_API_KEY or MEMORYNODE_API_KEY
 *
 * MEMORYNODE_SMOKE_API_KEY is intended for a dedicated "prod-smoke-tests" workspace
 * that should always keep active entitlement. If absent, this script falls back to
 * MEMORYNODE_API_KEY for backward compatibility with existing pipelines.
 * Loads .env.prod.smoke then .env.gate if present.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";

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
  console.log(`[smoke-prod] loaded ${path}`);
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
  return { res, text, json };
}

function keyIdentifier(apiKey) {
  const clean = String(apiKey ?? "").trim();
  if (!clean) return "missing";
  const fp = createHash("sha256").update(clean).digest("hex").slice(0, 8);
  const last4 = clean.slice(-4);
  return `${fp}...${last4}`;
}

function extractWorkspaceId(payload) {
  if (!payload || typeof payload !== "object") return null;
  const direct = payload.workspace_id ?? payload.workspaceId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = payload.error?.workspace_id ?? payload.error?.workspaceId;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  return null;
}

function isEntitlementRequired(status, payload) {
  const code = String(payload?.error?.code ?? "").toUpperCase();
  return status === 402 && code === "ENTITLEMENT_REQUIRED";
}

async function checkEntitlement(baseUrl, headers) {
  console.log("[smoke-prod] Pre-smoke entitlement check via GET /v1/usage/today");
  const outcome = await req(baseUrl, "/v1/usage/today", {
    method: "GET",
    headers: { authorization: String(headers.authorization ?? "") },
  }).catch((err) => {
    throw new Error(`Entitlement pre-check request failed: ${err.message}`);
  });

  const workspaceId = extractWorkspaceId(outcome.json);
  if (workspaceId) {
    console.log(`[smoke-prod] workspace_id=${workspaceId}`);
  }

  if (isEntitlementRequired(outcome.res.status, outcome.json)) {
    const effectivePlan = String(outcome.json?.error?.effective_plan ?? "unknown");
    throw new Error(
      "Smoke failed: API key workspace is not entitled (ENTITLEMENT_REQUIRED). "
      + `workspace_id=${workspaceId ?? "unknown"} effective_plan=${effectivePlan}`,
    );
  }
  if (!outcome.res.ok) {
    throw new Error(`Entitlement pre-check failed: HTTP ${outcome.res.status} ${outcome.res.statusText}`);
  }
  console.log(`[smoke-prod] entitlement_status=active plan=${String(outcome.json?.plan ?? "unknown")}`);
}

async function main() {
  loadEnvFile(".env.prod.smoke");
  loadEnvFile(".env.gate");

  const baseUrl = requireEnv(["PROD_BASE_URL", "BASE_URL"]);
  const apiKey = requireEnv(["MEMORYNODE_SMOKE_API_KEY", "PROD_API_KEY", "MEMORYNODE_API_KEY"]);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  console.log(`[smoke-prod] key_id=${keyIdentifier(apiKey)}`);

  const suffix = Date.now();
  const namespace = "smoke";
  const user = "smoke-user";
  const text1 = `prod smoke one ${suffix}`;
  const text2 = `prod smoke two ${suffix}`;

  console.log("[smoke-prod] GET /healthz");
  const health = await req(baseUrl, "/healthz");
  if (!health.res.ok) {
    throw new Error(`HTTP ${health.res.status} ${health.res.statusText} for /healthz body=${health.text.slice(0, 300)}`);
  }

  await checkEntitlement(baseUrl, headers);

  console.log("[smoke-prod] POST /v1/memories #1");
  const mem1 = await req(baseUrl, "/v1/memories", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: user, namespace, text: text1 }),
  });
  if (isEntitlementRequired(mem1.res.status, mem1.json)) {
    throw new Error(
      "Smoke write failed due to missing entitlement. "
      + "This is a configuration issue (API key -> workspace -> billing), not a deployment failure.",
    );
  }
  if (!mem1.res.ok) {
    throw new Error(`HTTP ${mem1.res.status} ${mem1.res.statusText} for /v1/memories body=${mem1.text.slice(0, 300)}`);
  }

  console.log("[smoke-prod] POST /v1/memories #2");
  const mem2 = await req(baseUrl, "/v1/memories", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: user, namespace, text: text2 }),
  });
  if (isEntitlementRequired(mem2.res.status, mem2.json)) {
    throw new Error(
      "Smoke write failed due to missing entitlement. "
      + "This is a configuration issue (API key -> workspace -> billing), not a deployment failure.",
    );
  }
  if (!mem2.res.ok) {
    throw new Error(`HTTP ${mem2.res.status} ${mem2.res.statusText} for /v1/memories body=${mem2.text.slice(0, 300)}`);
  }

  console.log("[smoke-prod] POST /v1/search");
  const search = await req(baseUrl, "/v1/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: user, namespace, query: "prod smoke", top_k: 5 }),
  });
  if (!search.res.ok) {
    throw new Error(`HTTP ${search.res.status} ${search.res.statusText} for /v1/search body=${search.text.slice(0, 300)}`);
  }
  const hits = Array.isArray(search.json?.results) ? search.json.results.length : 0;
  if (hits < 1) throw new Error("Search returned 0 results");

  console.log("[smoke-prod] POST /v1/context");
  const ctx = await req(baseUrl, "/v1/context", {
    method: "POST",
    headers,
    body: JSON.stringify({ user_id: user, namespace, query: "prod smoke", top_k: 5 }),
  });
  if (!ctx.res.ok) {
    throw new Error(`HTTP ${ctx.res.status} ${ctx.res.statusText} for /v1/context body=${ctx.text.slice(0, 300)}`);
  }
  if (!ctx.json?.context_text || String(ctx.json.context_text).trim() === "") {
    throw new Error("Context response missing context_text");
  }

  console.log("[smoke-prod] GET /v1/usage/today");
  const usage = await req(baseUrl, "/v1/usage/today", { headers: { authorization: `Bearer ${apiKey}` } });
  if (!usage.res.ok) {
    throw new Error(`HTTP ${usage.res.status} ${usage.res.statusText} for /v1/usage/today body=${usage.text.slice(0, 300)}`);
  }

  console.log("✅ prod smoke passed");
}

main().catch((err) => {
  console.error("❌ prod smoke failed:", err.message);
  process.exit(1);
});
