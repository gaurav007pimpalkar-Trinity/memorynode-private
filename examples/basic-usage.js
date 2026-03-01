#!/usr/bin/env node
/**
 * MemoryNode basic usage: insert a memory, search, and log results.
 * Usage: BASE_URL=https://api.memorynode.ai API_KEY=mn_live_xxx node examples/basic-usage.js
 */

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:8787").trim();
const API_KEY = (process.env.API_KEY || "").trim();

if (!API_KEY) {
  console.error("Set API_KEY (e.g. export API_KEY=mn_live_xxx)");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

async function main() {
  // Insert memory
  const insertRes = await fetch(`${BASE_URL}/v1/memories`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user_id: "user-1",
      namespace: "default",
      text: "User prefers dark mode and uses a Mac.",
    }),
  });
  const insertJson = await insertRes.json();
  if (!insertRes.ok) {
    console.error("Insert failed:", insertRes.status, insertJson);
    process.exit(1);
  }
  console.log("Insert:", insertJson.memory_id, "chunks:", insertJson.chunks);

  // Search memory
  const searchRes = await fetch(`${BASE_URL}/v1/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user_id: "user-1",
      namespace: "default",
      query: "theme preference",
      top_k: 5,
    }),
  });
  const searchJson = await searchRes.json();
  if (!searchRes.ok) {
    console.error("Search failed:", searchRes.status, searchJson);
    process.exit(1);
  }
  const results = searchJson.results || [];
  console.log("Search:", results.length, "results");
  results.forEach((r, i) => {
    console.log(`  ${i + 1}. score=${r.score.toFixed(3)} ${r.text.slice(0, 60)}...`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
