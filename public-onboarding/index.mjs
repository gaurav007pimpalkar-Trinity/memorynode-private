#!/usr/bin/env node
/**
 * MemoryNode quickstart — add a memory and search for it using @memorynodeai/sdk.
 * Requires: API_KEY (and optionally BASE_URL for production).
 */

import { MemoryNodeClient } from "@memorynodeai/sdk";

const apiKey = process.env.API_KEY?.trim();
if (!apiKey) {
  console.error("Error: API_KEY is required. Get a key at https://app.memorynode.ai");
  console.error("Usage: API_KEY=your_key [BASE_URL=https://api.memorynode.ai] node index.mjs");
  process.exit(1);
}

const baseUrl = process.env.BASE_URL?.trim() || "https://api.memorynode.ai";
const client = new MemoryNodeClient({ apiKey, baseUrl });

const userId = "quickstart-user";
const namespace = "default";

async function main() {
  console.log("MemoryNode quickstart\n");

  // Add a sample memory
  const text = `Quickstart memory created at ${new Date().toISOString()}`;
  const added = await client.addMemory({
    userId,
    namespace,
    text,
    metadata: { source: "memorynode-quickstart" },
  });
  console.log("Added memory:", added?.id ?? "(see response above)");

  // Search for that memory
  const results = await client.search({
    userId,
    namespace,
    query: "quickstart memory",
    topK: 5,
  });
  console.log("\nSearch results:");
  console.log(JSON.stringify(results, null, 2));

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
