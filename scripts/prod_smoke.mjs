#!/usr/bin/env node
/**
 * Production smoke test against the deployed Cloudflare Worker.
 * Requires Node 20+ (built-in fetch/crypto).
 *
 * Usage (bash):
 *   MASTER_ADMIN_TOKEN=... SUPABASE_SERVICE_ROLE_KEY=... API_KEY_SALT=... node scripts/prod_smoke.mjs
 *
 * Usage (PowerShell):
 *   $env:MASTER_ADMIN_TOKEN="..." ; $env:SUPABASE_SERVICE_ROLE_KEY="..." ; $env:API_KEY_SALT="..."; node scripts/prod_smoke.mjs
 */

import { createHash } from "node:crypto";

const BASE_URL = process.env.BASE_URL ?? "https://api.memorynode.ai";
const ADMIN_TOKEN = process.env.MASTER_ADMIN_TOKEN;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_KEY_SALT_ENV = process.env.API_KEY_SALT;
const SUPABASE_URL = process.env.SUPABASE_URL;

const requiredEnv = ["MASTER_ADMIN_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "API_KEY_SALT", "SUPABASE_URL"];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

function mask(value) {
  if (!value) return "<empty>";
  if (value.length <= 8) return `${value[0]}***${value[value.length - 1]}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function fingerprint(value) {
  if (typeof value !== "string") return "<none>";
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function sha256Hex(str) {
  return createHash("sha256").update(str).digest("hex");
}

function parseApiKeyMeta(raw) {
  const parts = raw.trim().split("_");
  if (parts.length >= 3) {
    return { prefix: parts.slice(0, 2).join("_"), last4: raw.slice(-4) };
  }
  return { prefix: parts[0] ?? "unknown", last4: raw.slice(-4) };
}

async function http(method, path, { headers = {}, body } = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // ignore
  }
  return { res, json };
}

async function main() {
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`MASTER_ADMIN_TOKEN: ${mask(ADMIN_TOKEN)}`);

  // 1) health
  console.log("\n[1] GET /healthz");
  const health = await http("GET", "/healthz", { headers: { "x-admin-token": ADMIN_TOKEN } });
  if (!health.res.ok) return fail("healthz", health);
  console.log(" healthz OK");

  // 2) create workspace
  console.log("\n[2] POST /v1/workspaces");
  const wsName = `prod-smoke-${Date.now()}`;
  const ws = await http("POST", "/v1/workspaces", {
    headers: { "x-admin-token": ADMIN_TOKEN },
    body: { name: wsName },
  });
  if (!ws.res.ok || !ws.json?.workspace_id) return fail("create workspace", ws);
  const workspaceId = ws.json.workspace_id;
  console.log(` workspace_id: ${workspaceId}`);

  // 3) create api key
  console.log("\n[3] POST /v1/api-keys");
  const keyResp = await http("POST", "/v1/api-keys", {
    headers: { "x-admin-token": ADMIN_TOKEN },
    body: { workspace_id: workspaceId, name: "prod-smoke-key" },
  });
  if (!keyResp.res.ok || !keyResp.json?.api_key) return fail("create api key", keyResp);
  const apiKey = keyResp.json.api_key;
  globalThis.__lastApiKey = apiKey;
  globalThis.__lastWorkspaceId = workspaceId;
  const meta = parseApiKeyMeta(apiKey);
  console.log(` api_key: ${mask(apiKey)} (prefix=${meta.prefix}, last4=${meta.last4})`);

  // 4) ingest memory
  console.log("\n[4] POST /v1/memories");
  const ing = await http("POST", "/v1/memories", {
    headers: { authorization: `Bearer ${apiKey}` },
    body: { user_id: "smoke-user", text: "hello from prod smoke" },
  });
  if (!ing.res.ok) {
    console.error(" ingest failed", dump(ing));
    await maybeDiagnoseSalt(ing);
    process.exit(1);
  }
  console.log(" ingest OK");

  // 5) search
  console.log("\n[5] POST /v1/search");
  const search = await http("POST", "/v1/search", {
    headers: { authorization: `Bearer ${apiKey}` },
    body: { user_id: "smoke-user", query: "hello", top_k: 3 },
  });
  if (!search.res.ok) return fail("search", search);
  console.log(` search hits: ${(search.json?.matches ?? []).length}`);

  console.log("\n✅ PROD SMOKE PASS");
  process.exit(0);
}

function fail(step, result) {
  console.error(`\n❌ ${step} failed: status=${result.res.status}`);
  console.error(dump(result));
  process.exit(1);
}

function dump(result) {
  return JSON.stringify(
    {
      status: result.res.status,
      headers: Object.fromEntries(result.res.headers.entries()),
      body: result.json,
    },
    null,
    2,
  );
}

async function maybeDiagnoseSalt(result) {
  const msg = result.json?.error?.message ?? "";
  if (!msg.includes("API key salt mismatch")) return;
  console.log("\nDetected API key salt mismatch. Running diagnostics...");

  const restUrl = `${SUPABASE_URL}/rest/v1/app_settings?id=eq.true&select=api_key_salt`;
  const resp = await fetch(restUrl, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      accept: "application/json",
    },
  });
  if (!resp.ok) {
    console.error(`Failed to read app_settings from Supabase (status ${resp.status})`);
    return;
  }
  const rows = await resp.json();
  const dbSalt = rows?.[0]?.api_key_salt ?? "";

  const envLen = API_KEY_SALT_ENV?.length ?? 0;
  const dbLen = dbSalt.length;
  const envFp = fingerprint(API_KEY_SALT_ENV ?? "");
  const dbFp = fingerprint(dbSalt);
  const match = dbSalt && API_KEY_SALT_ENV && dbSalt === API_KEY_SALT_ENV;

  // Also print key hash comparison if we still have the last created key.
  if (globalThis.__lastApiKey && globalThis.__lastWorkspaceId) {
    const keyRowUrl = `${SUPABASE_URL}/rest/v1/api_keys?workspace_id=eq.${globalThis.__lastWorkspaceId}&select=key_hash&order=created_at.desc&limit=1`;
    const keyRowResp = await fetch(keyRowUrl, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        accept: "application/json",
      },
    });
    if (keyRowResp.ok) {
      const keyRows = await keyRowResp.json();
      const stored = keyRows?.[0]?.key_hash ?? "";
      const meta = parseApiKeyMeta(globalThis.__lastApiKey);
      const computed = await sha256Hex((dbSalt || API_KEY_SALT_ENV || "") + globalThis.__lastApiKey);
      console.log(` - stored key_hash fp: ${fingerprint(stored)}`);
      console.log(` - computed key_hash fp: ${fingerprint(computed)}`);
      console.log(` - parsed prefix=${meta.prefix}, last4=${meta.last4}`);
    }
  }

  console.log(` - DB api_key_salt: len=${dbLen}, fp=${dbFp}`);
  console.log(` - ENV API_KEY_SALT: len=${envLen}, fp=${envFp}`);
  console.log(` - RESULT: ${match ? "MATCH" : "MISMATCH"}`);

  if (!match) {
    console.log("\nRemediation:");
    console.log(" 1) Align salts: update Supabase app_settings.api_key_salt to match Cloudflare API_KEY_SALT (or vice-versa).");
    console.log(" 2) Redeploy the Worker after updating secrets.");
    console.log(" 3) Create a fresh API key and retry the smoke test.");
  }
}

main().catch((err) => {
  console.error("Unexpected failure", err);
  process.exit(1);
});
