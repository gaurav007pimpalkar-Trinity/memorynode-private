#!/usr/bin/env node
/**
 * Optional: Phase 6 options — memory_type, extract, search_mode.
 * Run after index.mjs (same BASE_URL, API_KEY, USER_ID, NAMESPACE).
 */

const BASE_URL = (process.env.BASE_URL ?? "").trim();
const API_KEY = (process.env.API_KEY ?? "").trim();
const USER_ID = (process.env.USER_ID ?? "beta-user").trim();
const NAMESPACE = (process.env.NAMESPACE ?? "beta-default").trim();

function fail(msg) {
  console.error(`[phase6-options] ${msg}`);
  process.exit(1);
}
if (!BASE_URL || !API_KEY) fail("Missing BASE_URL or API_KEY");

const headers = () => ({ Authorization: `Bearer ${API_KEY}`, "content-type": "application/json" });

async function main() {
  // 1) Add memory with memory_type and optional extract
  const addRes = await fetch(new URL("/v1/memories", BASE_URL).toString(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      user_id: USER_ID,
      namespace: NAMESPACE,
      text: "I prefer dark mode and had lunch at the new café yesterday.",
      memory_type: "note",
      extract: true,
    }),
  });
  const addJson = await addRes.json();
  if (!addRes.ok) fail(`add memory: ${addJson?.error?.message ?? addRes.statusText}`);
  console.log("Add (memory_type + extract):", addJson.memory_id, addJson.extraction ? `extraction: ${JSON.stringify(addJson.extraction)}` : "");

  // 2) Search with search_mode and optional filter
  const searchRes = await fetch(new URL("/v1/search", BASE_URL).toString(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      user_id: USER_ID,
      namespace: NAMESPACE,
      query: "preferences",
      search_mode: "hybrid",
      filters: { memory_type: ["preference", "fact"] },
    }),
  });
  const searchJson = await searchRes.json();
  if (!searchRes.ok) fail(`search: ${searchJson?.error?.message ?? searchRes.statusText}`);
  console.log("Search (search_mode + memory_type filter):", searchJson.results?.length ?? 0, "results");

  // 3) Context with keyword-only (no embedding)
  const ctxRes = await fetch(new URL("/v1/context", BASE_URL).toString(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      user_id: USER_ID,
      namespace: NAMESPACE,
      query: "dark mode",
      search_mode: "keyword",
      top_k: 3,
    }),
  });
  const ctxJson = await ctxRes.json();
  if (!ctxRes.ok) fail(`context: ${ctxJson?.error?.message ?? ctxRes.statusText}`);
  console.log("Context (search_mode=keyword):", ctxJson.context_blocks ?? "—", "blocks");
  console.log("[phase6-options] done");
}

main().catch((e) => fail(e?.message ?? String(e)));
