#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const alertRulesPath = path.join(root, "docs", "observability", "alert_rules.json");
const sloTargetsPath = path.join(root, "docs", "observability", "slo_targets.json");

function fail(message) {
  console.error(`observability contract check failed: ${message}`);
  process.exit(1);
}

function loadJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    fail(`cannot parse ${p}: ${(err && err.message) || err}`);
  }
}

const alertRules = loadJson(alertRulesPath);
const sloTargets = loadJson(sloTargetsPath);

const requiredAlertIds = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "D1", "D2", "D3", "D4", "E1", "E2"];
const alertIds = new Set((alertRules.alerts ?? []).map((a) => a.id));
for (const id of requiredAlertIds) {
  if (!alertIds.has(id)) fail(`missing alert id ${id} in alert_rules.json`);
}

const services = Array.isArray(sloTargets.services) ? sloTargets.services : [];
if (services.length < 3) fail("slo_targets.json must define at least api, billing_webhook, dashboard_session services");
const requiredServices = new Set(["api", "billing_webhook", "dashboard_session"]);
for (const service of services) {
  if (requiredServices.has(service.id)) requiredServices.delete(service.id);
}
if (requiredServices.size > 0) {
  fail(`slo_targets.json missing services: ${Array.from(requiredServices).join(", ")}`);
}

if (!sloTargets.paging?.critical || !sloTargets.paging?.warning) {
  fail("slo_targets.json missing paging critical/warning sections");
}

console.log("observability contract check passed.");
