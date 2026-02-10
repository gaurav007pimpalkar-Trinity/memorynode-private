#!/usr/bin/env node
/**
 * MemoryNode Node quickstart:
 * 1) ingest memory
 * 2) search memory
 * 3) fetch prompt-ready context
 */

const BASE_URL = (process.env.BASE_URL ?? "").trim();
const API_KEY = (process.env.API_KEY ?? "").trim();
const USER_ID = (process.env.USER_ID ?? "beta-user").trim();
const NAMESPACE = (process.env.NAMESPACE ?? "beta-default").trim();
const TIMEOUT_MS = Number(process.env.MEMORYNODE_TIMEOUT_MS ?? "15000");

function fail(message) {
  console.error(`[node-quickstart] ${message}`);
  process.exit(1);
}

if (!BASE_URL) fail("Missing BASE_URL");
if (!API_KEY) fail("Missing API_KEY");

function authHeaders() {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "content-type": "application/json",
  };
}

async function callApi(method, path, body) {
  const url = new URL(path, BASE_URL).toString();
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // non-json response
  }
  const requestId =
    res.headers.get("x-request-id") ??
    (json && typeof json.request_id === "string" ? json.request_id : null) ??
    "<not-exposed>";
  return { res, json, raw, requestId };
}

function requireOk(step, outcome) {
  if (outcome.res.ok) return;
  const code = outcome.json?.error?.code ?? "UNKNOWN";
  const message = outcome.json?.error?.message ?? outcome.raw ?? "<empty>";
  fail(`${step} failed (${outcome.res.status}) code=${code} message=${message}`);
}

function printSection(title, payload) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  console.log("[node-quickstart] starting");
  console.log(`[node-quickstart] BASE_URL=${BASE_URL}`);
  console.log(`[node-quickstart] USER_ID=${USER_ID} NAMESPACE=${NAMESPACE}`);

  const text = `MemoryNode beta quickstart memory at ${new Date().toISOString()}`;

  const ingest = await callApi("POST", "/v1/memories", {
    user_id: USER_ID,
    namespace: NAMESPACE,
    text,
    metadata: { source: "node-quickstart" },
  });
  requireOk("ingest", ingest);
  printSection("INGEST", {
    status: ingest.res.status,
    request_id: ingest.requestId,
    body: ingest.json,
  });

  const search = await callApi("POST", "/v1/search", {
    user_id: USER_ID,
    namespace: NAMESPACE,
    query: "quickstart memory",
    top_k: 3,
  });
  requireOk("search", search);
  printSection("SEARCH", {
    status: search.res.status,
    request_id: search.requestId,
    hits: search.json?.results?.length ?? 0,
    body: search.json,
  });

  const context = await callApi("POST", "/v1/context", {
    user_id: USER_ID,
    namespace: NAMESPACE,
    query: "Summarize what you remember about the quickstart memory.",
    top_k: 3,
  });
  requireOk("context", context);
  printSection("CONTEXT", {
    status: context.res.status,
    request_id: context.requestId,
    citations: context.json?.citations?.length ?? 0,
    body: context.json,
  });

  console.log("\n[node-quickstart] PASS");
}

main().catch((err) => fail(`unexpected error: ${err?.message ?? String(err)}`));
