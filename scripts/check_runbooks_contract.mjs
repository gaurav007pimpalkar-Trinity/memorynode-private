#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const runbookPath = path.join(root, "docs", "internal", "INCIDENT_RUNBOOKS.md");

const text = readFileSync(runbookPath, "utf8");
const requiredSnippets = [
  "On-Call Ownership and Escalation",
  "Universal First 5 Minutes",
  "Auth outage / auth failure spike",
  "DB degradation / RPC failures",
  "Billing webhook forgery/replay/surge",
  "Rate-limit infrastructure outage / abuse spike",
  "Release regression / rollback",
  "Key or secret compromise",
  "Validation Checklist",
  "Required Quarterly Drills",
];

const missing = requiredSnippets.filter((snippet) => !text.includes(snippet));
if (missing.length > 0) {
  console.error(`runbook contract check failed: missing sections -> ${missing.join(", ")}`);
  process.exit(1);
}

console.log("runbook contract check passed.");
