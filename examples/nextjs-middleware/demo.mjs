#!/usr/bin/env node
/**
 * Runnable pseudo-integration demo for the Next.js snippet.
 * Calls the same MemoryNode endpoints used by route.ts.
 */

const BASE_URL = (process.env.BASE_URL ?? "").trim();
const API_KEY = (process.env.API_KEY ?? "").trim();
const USER_ID = (process.env.USER_ID ?? "nextjs-demo-user").trim();
const NAMESPACE = (process.env.NAMESPACE ?? "nextjs-demo").trim();

if (!BASE_URL || !API_KEY) {
  console.error("[nextjs-demo] Missing BASE_URL or API_KEY");
  process.exit(1);
}

async function call(path, body) {
  const res = await fetch(new URL(path, BASE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return json;
}

async function main() {
  const userMsg = "What do you remember about my preferences?";
  await call("/v1/memories", {
    user_id: USER_ID,
    namespace: NAMESPACE,
    text: "[user] I like concise API responses and markdown examples.",
    metadata: { source: "nextjs-demo" },
  });
  const context = await call("/v1/context", {
    user_id: USER_ID,
    namespace: NAMESPACE,
    query: userMsg,
    top_k: 5,
  });
  console.log("[nextjs-demo] Context ready");
  console.log(JSON.stringify(context, null, 2));
}

main().catch((err) => {
  console.error(`[nextjs-demo] ${err?.message ?? String(err)}`);
  process.exit(1);
});
