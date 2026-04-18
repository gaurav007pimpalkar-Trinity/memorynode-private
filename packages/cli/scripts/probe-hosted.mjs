const key = (process.env.API_KEY ?? process.env.MEMORYNODE_API_KEY ?? "").trim();
const base = (process.env.BASE_URL ?? process.env.MEMORYNODE_BASE_URL ?? "").trim();
if (!key || !base) {
  console.error("probe-hosted: missing API_KEY or BASE_URL");
  process.exit(1);
}
const url = new URL("/v1/usage/today", base);
const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
const text = await res.text();
console.log(`[mn] ${url} -> ${res.status}`);
console.log(text.slice(0, 800));
