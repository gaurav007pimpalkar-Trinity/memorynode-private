#!/usr/bin/env node
/**
 * Minimal support-bot style demo: ticket fact -> search -> context.
 * Same transport as examples/node-quickstart; different copy + default namespace.
 */

const BASE_URL = (process.env.BASE_URL ?? "").trim();
const API_KEY = (process.env.API_KEY ?? "").trim();
const USER_ID = (process.env.USER_ID ?? "demo-customer-1").trim();
const NAMESPACE = (process.env.NAMESPACE ?? "support").trim();
const TIMEOUT_MS = Number(process.env.MEMORYNODE_TIMEOUT_MS ?? "15000");

function fail(message) {
  console.error(`[support-bot-minimal] ${message}`);
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
    /* non-json */
  }
  return { res, json, raw };
}

function requireOk(step, outcome) {
  if (outcome.res.ok) return;
  const code = outcome.json?.error?.code ?? "UNKNOWN";
  const message = outcome.json?.error?.message ?? outcome.raw ?? "<empty>";
  fail(`${step} failed (${outcome.res.status}) code=${code} message=${message}`);
}

async function main() {
  console.log("[support-bot-minimal] BASE_URL=%s USER_ID=%s NAMESPACE=%s", BASE_URL, USER_ID, NAMESPACE);

  const ticketNote = `Ticket demo: customer asked for delivery to Pune; agent confirmed address update at ${new Date().toISOString()}.`;

  const ingest = await callApi("POST", "/v1/memories", {
    user_id: USER_ID,
    namespace: NAMESPACE,
    text: ticketNote,
    metadata: { source: "support-bot-minimal", channel: "chat" },
  });
  requireOk("ingest", ingest);
  console.log("[support-bot-minimal] ingest ok memory_id=%s", ingest.json?.memory_id ?? "?");

  const search = await callApi("POST", "/v1/search", {
    user_id: USER_ID,
    namespace: NAMESPACE,
    query: "delivery address Pune",
    top_k: 5,
  });
  requireOk("search", search);
  console.log("[support-bot-minimal] search hits=%s", Array.isArray(search.json?.results) ? search.json.results.length : 0);

  const ctx = await callApi("POST", "/v1/context", {
    user_id: USER_ID,
    namespace: NAMESPACE,
    query: "What do we know about this customer's delivery?",
    top_k: 5,
  });
  requireOk("context", ctx);
  const text = ctx.json?.context_text ?? "";
  console.log("[support-bot-minimal] context_text (truncated): %s", text.slice(0, 400));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
