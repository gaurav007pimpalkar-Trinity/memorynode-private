#!/usr/bin/env node
/**
 * Bootstrap a production smoke workspace + API key.
 *
 * Uses existing admin APIs only:
 * - POST /v1/workspaces
 * - GET /v1/api-keys
 * - POST /v1/api-keys
 * - POST /v1/api-keys/revoke
 *
 * Required env:
 * - MASTER_ADMIN_TOKEN (or ADMIN_TOKEN)
 * - BASE_URL (or PROD_BASE_URL)
 */

import fs from "node:fs";
import path from "node:path";

const BASE_URL = (process.env.PROD_BASE_URL ?? process.env.BASE_URL ?? "https://api.memorynode.ai").replace(/\/+$/, "");
const ADMIN_TOKEN = (process.env.MASTER_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "").trim();
const WORKSPACE_NAME = (process.env.SMOKE_WORKSPACE_NAME ?? "smoke-prod").trim();
const WORKSPACE_ID_OVERRIDE = (process.env.SMOKE_WORKSPACE_ID ?? "").trim();
const API_KEY_NAME = (process.env.SMOKE_API_KEY_NAME ?? "ci-smoke-key").trim();
const KEY_STRATEGY = (process.env.SMOKE_KEY_STRATEGY ?? "rotate").trim().toLowerCase(); // rotate | reuse
const GRANT_REASON = (process.env.SMOKE_GRANT_REASON ?? "production_smoke_workspace").trim();
const STATE_PATH = path.resolve(process.cwd(), process.env.SMOKE_BOOTSTRAP_STATE_PATH ?? ".smoke-workspace-state.json");

function fail(message) {
  console.error(`[bootstrap-smoke] ${message}`);
  process.exit(1);
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(`[bootstrap-smoke] warning: could not write state file (${String(error?.message ?? error)})`);
  }
}

async function callApi(method, endpoint, { body, query } = {}) {
  const url = new URL(endpoint, `${BASE_URL}/`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || String(v).trim() === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-admin-token": ADMIN_TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text fallback
  }
  const requestId = response.headers.get("x-request-id") ?? json?.request_id ?? "unknown";
  return { response, json, text, requestId };
}

async function ensureWorkspaceId() {
  const state = loadState();

  if (WORKSPACE_ID_OVERRIDE) {
    return WORKSPACE_ID_OVERRIDE;
  }

  if (
    state &&
    typeof state.workspace_id === "string" &&
    state.workspace_id.trim() &&
    state.workspace_name === WORKSPACE_NAME
  ) {
    return state.workspace_id.trim();
  }

  const created = await callApi("POST", "/v1/workspaces", {
    body: {
      name: WORKSPACE_NAME,
      internal: true,
      entitlement_source: "internal_grant",
      grant_reason: GRANT_REASON,
    },
  });
  if (!created.response.ok || !created.json?.workspace_id) {
    fail(
      `workspace create failed status=${created.response.status} request_id=${created.requestId} body=${created.text.slice(0, 300)}`,
    );
  }
  const workspaceId = String(created.json.workspace_id);
  saveState({
    workspace_id: workspaceId,
    workspace_name: WORKSPACE_NAME,
    updated_at: new Date().toISOString(),
  });
  return workspaceId;
}

async function listWorkspaceKeys(workspaceId) {
  const listed = await callApi("GET", "/v1/api-keys", {
    query: { workspace_id: workspaceId },
  });
  if (!listed.response.ok) {
    fail(`api key list failed status=${listed.response.status} request_id=${listed.requestId} body=${listed.text.slice(0, 300)}`);
  }
  return Array.isArray(listed.json?.api_keys) ? listed.json.api_keys : [];
}

async function revokeApiKey(apiKeyId) {
  const revoked = await callApi("POST", "/v1/api-keys/revoke", {
    body: { api_key_id: apiKeyId },
  });
  if (!revoked.response.ok) {
    fail(
      `api key revoke failed api_key_id=${apiKeyId} status=${revoked.response.status} request_id=${revoked.requestId} body=${revoked.text.slice(0, 300)}`,
    );
  }
}

async function createApiKey(workspaceId) {
  const created = await callApi("POST", "/v1/api-keys", {
    body: {
      workspace_id: workspaceId,
      name: API_KEY_NAME,
    },
  });
  if (!created.response.ok || !created.json?.api_key) {
    fail(
      `api key create failed status=${created.response.status} request_id=${created.requestId} body=${created.text.slice(0, 300)}`,
    );
  }
  return {
    apiKey: String(created.json.api_key),
    apiKeyId: String(created.json.api_key_id ?? ""),
  };
}

async function main() {
  if (!ADMIN_TOKEN) {
    fail("missing MASTER_ADMIN_TOKEN (or ADMIN_TOKEN)");
  }
  if (!["rotate", "reuse"].includes(KEY_STRATEGY)) {
    fail("SMOKE_KEY_STRATEGY must be rotate or reuse");
  }

  const workspaceId = await ensureWorkspaceId();
  const keys = await listWorkspaceKeys(workspaceId);
  const existingActive = keys.filter(
    (row) => row && row.name === API_KEY_NAME && row.revoked_at == null && typeof row.id === "string",
  );

  if (KEY_STRATEGY === "reuse" && existingActive.length > 0) {
    fail(
      `active key "${API_KEY_NAME}" already exists (api_key_id=${existingActive[0].id}). Plaintext cannot be retrieved; use SMOKE_KEY_STRATEGY=rotate to mint a fresh key.`,
    );
  }

  if (KEY_STRATEGY === "rotate") {
    for (const row of existingActive) {
      await revokeApiKey(row.id);
    }
  }

  const { apiKey, apiKeyId } = await createApiKey(workspaceId);
  console.log("------------------------------------------------------------");
  console.log("Smoke workspace bootstrap complete");
  console.log(`workspace_id: ${workspaceId}`);
  console.log(`api_key_id:   ${apiKeyId || "unknown"}`);
  console.log("api_key (save now; shown once):");
  console.log(apiKey);
  console.log("------------------------------------------------------------");
  console.log("Next step: set GitHub production secret MEMORYNODE_SMOKE_API_KEY to this api_key.");
}

main().catch((error) => {
  fail(`unexpected error: ${String(error?.message ?? error)}`);
});
