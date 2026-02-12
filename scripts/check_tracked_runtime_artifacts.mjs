#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const raw = execSync("git ls-files", { encoding: "utf8" });
const files = raw
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s && existsSync(s));
const blocked = files.filter((file) => /\.(txt|log)$/i.test(file) && !file.startsWith("docs/"));

if (blocked.length > 0) {
  console.error("tracked runtime artifacts are not allowed:");
  for (const file of blocked) console.error(`- ${file}`);
  console.error("Move runtime artifacts to .tmp/ or docs/generated and keep them untracked.");
  process.exit(1);
}

console.log("tracked runtime artifact check passed");
