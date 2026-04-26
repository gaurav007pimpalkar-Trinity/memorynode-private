#!/usr/bin/env node
/**
 * Post-deploy environment validation.
 *
 * Inputs:
 *   BASE_URL (or STAGING_BASE_URL / PROD_BASE_URL with TARGET_ENV)
 *   API_KEY (or MEMORYNODE_API_KEY) OR MASTER_ADMIN_TOKEN / ADMIN_TOKEN
 *   Optional WORKSPACE_ID (used when creating API key from admin token)
 *   Optional CONTROL_PLANE_BASE_URL (or prefixed): POST /admin/* hits this host; defaults to BASE_URL if unset
 *   Optional CONTROL_PLANE_SECRET: sent as `x-internal-secret` on control-plane requests (required when the Worker enforces the gate)
 *
 * Examples:
 *   BASE_URL=https://api-staging.example.com API_KEY=mn_live_xxx pnpm release:validate
 *   TARGET_ENV=staging STAGING_BASE_URL=https://api-staging.example.com MASTER_ADMIN_TOKEN=... pnpm release:staging:validate
 */

const TARGET_ENV = (process.env.TARGET_ENV ?? "").trim().toLowerCase();
const TIMEOUT_MS = Number(process.env.RELEASE_VALIDATE_TIMEOUT_MS ?? "20000");

function firstNonEmpty(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function targetPrefixes(target) {
  switch (target) {
    case "staging":
      return ["STAGING"];
    case "production":
    case "prod":
      return ["PROD", "PRODUCTION"];
    default:
      return [];
  }
}

function resolveWithTarget(baseNames) {
  const prefixed = [];
  for (const prefix of targetPrefixes(TARGET_ENV)) {
    for (const name of baseNames) {
      prefixed.push(`${prefix}_${name}`);
    }
  }
  const values = [...baseNames, ...prefixed].map((name) => process.env[name]);
  return firstNonEmpty(values);
}

function mask(value) {
  if (!value) return "<empty>";
  if (value.length <= 8) return `${value[0]}***${value[value.length - 1]}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function requestJson(baseUrl, method, path, { headers = {}, body } = {}) {
  const url = new URL(path, baseUrl).toString();
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body
  }
  return {
    url,
    response,
    text,
    json,
    requestId: response.headers.get("x-request-id") ?? "",
  };
}

function fail(step, outcome, extra = "") {
  const status = outcome?.response?.status ?? 0;
  const code = outcome?.json?.error?.code ?? "<none>";
  const message = outcome?.json?.error?.message ?? "<none>";
  const requestId = outcome?.requestId || "<missing>";
  const bodyPreview = (outcome?.text ?? "").slice(0, 400);
  console.error(`\n[release:validate] FAIL ${step}`);
  console.error(` status=${status} request_id=${requestId} error_code=${code} error_message=${message}`);
  if (extra) console.error(` ${extra}`);
  if (bodyPreview) console.error(` body=${bodyPreview}`);
  process.exit(1);
}

function ensureRequestId(step, outcome) {
  if (!outcome.requestId) {
    fail(step, outcome, "Missing x-request-id header in response.");
  }
}

function pass(step, detail) {
  console.log(`[release:validate] PASS ${step} ${detail ? `- ${detail}` : ""}`);
}

function isCapExceeded(outcome) {
  return outcome.response.status === 402 && outcome.json?.error?.code === "CAP_EXCEEDED";
}

function isBillingDisabled(outcome) {
  return outcome.response.status === 503 && outcome.json?.error?.code === "BILLING_NOT_CONFIGURED";
}

async function main() {
  const baseUrl = resolveWithTarget(["BASE_URL"]);
  const controlPlaneBaseUrl = firstNonEmpty([
    process.env.CONTROL_PLANE_BASE_URL,
    resolveWithTarget(["CONTROL_PLANE_BASE_URL"]),
    baseUrl,
  ]);
  let apiKey = firstNonEmpty([
    process.env.API_KEY,
    process.env.MEMORYNODE_API_KEY,
    resolveWithTarget(["API_KEY"]),
    resolveWithTarget(["MEMORYNODE_API_KEY"]),
  ]);
  const adminToken = firstNonEmpty([
    process.env.ADMIN_TOKEN,
    process.env.MASTER_ADMIN_TOKEN,
    resolveWithTarget(["ADMIN_TOKEN"]),
    resolveWithTarget(["MASTER_ADMIN_TOKEN"]),
  ]);
  const controlPlaneSecret = firstNonEmpty([
    process.env.CONTROL_PLANE_SECRET,
    resolveWithTarget(["CONTROL_PLANE_SECRET"]),
  ]);
  let workspaceId = firstNonEmpty([process.env.WORKSPACE_ID, resolveWithTarget(["WORKSPACE_ID"])]);

  if (!baseUrl) {
    console.error("Missing BASE_URL (or env-specific equivalent such as STAGING_BASE_URL/PROD_BASE_URL).");
    process.exit(1);
  }
  if (!apiKey && !adminToken) {
    console.error("Missing credentials. Provide API_KEY (or MEMORYNODE_API_KEY) or MASTER_ADMIN_TOKEN.");
    process.exit(1);
  }

  console.log(`[release:validate] TARGET_ENV=${TARGET_ENV || "<unset>"}`);
  console.log(`[release:validate] BASE_URL=${baseUrl}`);
  console.log(`[release:validate] CONTROL_PLANE_BASE_URL=${controlPlaneBaseUrl}`);
  console.log(`[release:validate] API_KEY=${mask(apiKey)}`);
  console.log(`[release:validate] ADMIN_TOKEN=${mask(adminToken)}`);
  if (workspaceId) {
    console.log(`[release:validate] WORKSPACE_ID=${workspaceId}`);
  }

  const health = await requestJson(baseUrl, "GET", "/healthz");
  ensureRequestId("GET /healthz", health);
  if (!health.response.ok || health.json?.status !== "ok") {
    fail("GET /healthz", health, "Expected 200 with { status: \"ok\" }.");
  }
  const version = health.json?.build_version ?? health.json?.version ?? "<missing>";
  const gitSha = health.json?.git_sha ?? "<missing>";
  if (version === "<missing>") {
    fail("GET /healthz", health, "Expected build_version/version in health response.");
  }
  pass("GET /healthz", `version=${version} git_sha=${gitSha} request_id=${health.requestId}`);

  if (!apiKey && adminToken) {
    if (!workspaceId) {
      const ws = await requestJson(baseUrl, "POST", "/v1/workspaces", {
        headers: { "x-admin-token": adminToken },
        body: { name: `release-validate-${Date.now()}` },
      });
      ensureRequestId("POST /v1/workspaces", ws);
      if (!ws.response.ok || !ws.json?.workspace_id) {
        fail("POST /v1/workspaces", ws, "Expected workspace_id.");
      }
      workspaceId = ws.json.workspace_id;
      pass("POST /v1/workspaces", `workspace_id=${workspaceId} request_id=${ws.requestId}`);
    }

    const keyResp = await requestJson(baseUrl, "POST", "/v1/api-keys", {
      headers: { "x-admin-token": adminToken },
      body: { workspace_id: workspaceId, name: "release-validate-key" },
    });
    ensureRequestId("POST /v1/api-keys", keyResp);
    if (!keyResp.response.ok || !keyResp.json?.api_key) {
      fail("POST /v1/api-keys", keyResp, "Expected api_key in response.");
    }
    apiKey = keyResp.json.api_key;
    pass("POST /v1/api-keys", `api_key=${mask(apiKey)} request_id=${keyResp.requestId}`);
  }

  const authHeaders = { authorization: `Bearer ${apiKey}` };

  const usage = await requestJson(baseUrl, "GET", "/v1/usage/today", { headers: authHeaders });
  ensureRequestId("GET /v1/usage/today", usage);
  if (!usage.response.ok) {
    fail("GET /v1/usage/today", usage);
  }
  pass("GET /v1/usage/today", `request_id=${usage.requestId}`);

  const search = await requestJson(baseUrl, "POST", "/v1/search", {
    headers: authHeaders,
    body: { user_id: "release-validate-user", query: "release validation", top_k: 3 },
  });
  ensureRequestId("POST /v1/search", search);
  if (!search.response.ok && !isCapExceeded(search)) {
    fail("POST /v1/search", search);
  }
  pass(
    "POST /v1/search",
    isCapExceeded(search)
      ? `cap-exceeded accepted request_id=${search.requestId}`
      : `request_id=${search.requestId}`,
  );

  const context = await requestJson(baseUrl, "POST", "/v1/context", {
    headers: authHeaders,
    body: { user_id: "release-validate-user", query: "release validation", top_k: 3 },
  });
  ensureRequestId("POST /v1/context", context);
  if (!context.response.ok && !isCapExceeded(context)) {
    fail("POST /v1/context", context);
  }
  pass(
    "POST /v1/context",
    isCapExceeded(context)
      ? `cap-exceeded accepted request_id=${context.requestId}`
      : `request_id=${context.requestId}`,
  );

  const billing = await requestJson(baseUrl, "GET", "/v1/billing/status", {
    headers: authHeaders,
  });
  ensureRequestId("GET /v1/billing/status", billing);

  if (isBillingDisabled(billing)) {
    pass("GET /v1/billing/status", `billing disabled request_id=${billing.requestId}`);
  } else if (!billing.response.ok) {
    fail("GET /v1/billing/status", billing);
  } else {
    pass("GET /v1/billing/status", `billing enabled request_id=${billing.requestId}`);
    if (adminToken) {
      const reprocessHeaders = { "x-admin-token": adminToken };
      if (controlPlaneSecret) reprocessHeaders["x-internal-secret"] = controlPlaneSecret;
      const reprocess = await requestJson(
        controlPlaneBaseUrl,
        "POST",
        "/admin/webhooks/reprocess?status=deferred&limit=1",
        {
          headers: reprocessHeaders,
        },
      );
      ensureRequestId("POST /admin/webhooks/reprocess", reprocess);
      if (!reprocess.response.ok) {
        fail("POST /admin/webhooks/reprocess", reprocess);
      }
      pass("POST /admin/webhooks/reprocess", `request_id=${reprocess.requestId}`);
    } else {
      console.log("[release:validate] WARN billing enabled but admin token absent; skipped webhook table check.");
    }
  }

  console.log("\n[release:validate] RESULT: PASS");
}

main().catch((err) => {
  console.error(`[release:validate] unexpected failure: ${err?.message ?? String(err)}`);
  console.error("[release:validate] RESULT: FAIL");
  process.exit(1);
});
