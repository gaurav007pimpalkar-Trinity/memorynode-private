#!/usr/bin/env node
/**
 * Full Cloudflare infrastructure audit via API.
 * Uses CLOUDFLARE_API_TOKEN from environment or .env in repo root.
 * Writes: docs/cloudflare_audit_data.json and docs/CLOUDFLARE_INFRASTRUCTURE_AUDIT.md
 * Does not modify or delete any resources.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadEnv() {
  try {
    const envPath = join(root, ".env");
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch (_) {}
}

loadEnv();

const BASE = "https://api.cloudflare.com/client/v4";
let token = process.env.CLOUDFLARE_API_TOKEN;
// Optional: token from file (e.g. CLOUDFLARE_API_TOKEN_FILE=.cf_token)
if (!token && process.env.CLOUDFLARE_API_TOKEN_FILE) {
  try {
    token = readFileSync(join(root, process.env.CLOUDFLARE_API_TOKEN_FILE), "utf8").trim();
  } catch (_) {}
}
if (!token) {
  console.error("CLOUDFLARE_API_TOKEN is required (env, .env in repo root, or CLOUDFLARE_API_TOKEN_FILE).");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function cf(path, method = "GET", body = null) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const opt = { method, headers };
  if (body) opt.body = JSON.stringify(body);
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));
  if (!data.success && data.errors?.length) {
    throw new Error(`CF API ${path}: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

async function paginate(path, resultKey = "result", perPage = 100) {
  const out = [];
  let page = 1;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await cf(`${path}${sep}page=${page}&per_page=${perPage}`);
    const list = data[resultKey] ?? data.result ?? [];
    if (!Array.isArray(list)) break;
    out.push(...list);
    if (list.length < perPage) break;
    page++;
  }
  return out;
}

async function main() {
  const audit = {
    meta: { runAt: new Date().toISOString(), tokenPresent: !!token },
    zones: [],
    dnsByZone: {},
    workerRoutesByZone: {},
    accountId: null,
    workers: [],
    workerDetails: {},
    d1Databases: [],
    queues: [],
    pagesProjects: [],
    pagesProjectDetails: {},
    errors: [],
  };

  // --- Zones ---
  try {
    audit.zones = await paginate("/zones");
    if (audit.zones.length && audit.zones[0].account)
      audit.accountId = audit.zones[0].account.id;
  } catch (e) {
    audit.errors.push({ step: "zones", error: String(e.message) });
  }

  // --- DNS and Worker routes per zone ---
  for (const zone of audit.zones) {
    const zid = zone.id;
    try {
      audit.dnsByZone[zid] = await paginate(`/zones/${zid}/dns_records`);
    } catch (e) {
      audit.errors.push({ step: `dns_${zid}`, error: String(e.message) });
      audit.dnsByZone[zid] = [];
    }
    try {
      const routesData = await cf(`/zones/${zid}/workers/routes`);
      audit.workerRoutesByZone[zid] = routesData.result ?? [];
    } catch (e) {
      audit.errors.push({ step: `worker_routes_${zid}`, error: String(e.message) });
      audit.workerRoutesByZone[zid] = [];
    }
  }

  const accountId = audit.accountId;
  if (!accountId) {
    audit.errors.push({ step: "account", error: "No account ID from zones" });
  } else {
    // --- Workers ---
    try {
      const scriptsData = await cf(`/accounts/${accountId}/workers/scripts`);
      const raw = scriptsData.result;
      let workerNames = [];
      if (Array.isArray(raw)) {
        workerNames = raw.map((s) => (typeof s === "string" ? s : s?.id ?? s?.script_name ?? s?.name)).filter(Boolean);
        audit.workers = raw.map((s) => (typeof s === "object" && s !== null ? s : { id: s }));
      } else if (raw && typeof raw === "object") {
        workerNames = Object.keys(raw);
        audit.workers = workerNames.map((id) => ({ id }));
      }
      for (const name of workerNames) {
        try {
          const detail = await cf(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}`);
          audit.workerDetails[name] = detail.result ?? detail;
        } catch (_) {
          audit.workerDetails[name] = null;
        }
      }
    } catch (e) {
      audit.errors.push({ step: "workers", error: String(e.message) });
    }

    // --- D1 ---
    try {
      const d1Data = await cf(`/accounts/${accountId}/d1/database`);
      audit.d1Databases = d1Data.result ?? [];
    } catch (e) {
      audit.errors.push({ step: "d1", error: String(e.message) });
    }

    // --- Queues ---
    try {
      const qData = await cf(`/accounts/${accountId}/queues`);
      audit.queues = qData.result ?? [];
    } catch (e) {
      audit.errors.push({ step: "queues", error: String(e.message) });
    }

    // --- Pages ---
    try {
      const pagesData = await cf(`/accounts/${accountId}/pages/projects`);
      const projects = pagesData.result ?? [];
      audit.pagesProjects = Array.isArray(projects) ? projects : [];
      for (const p of audit.pagesProjects) {
        const name = p.name ?? p.project_name;
        if (!name) continue;
        try {
          const detail = await cf(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`);
          audit.pagesProjectDetails[name] = detail.result ?? detail;
        } catch (_) {
          audit.pagesProjectDetails[name] = null;
        }
      }
    } catch (e) {
      audit.errors.push({ step: "pages", error: String(e.message) });
    }
  }

  return audit;
}

function mdTable(headers, rows) {
  const sep = "| " + headers.map(() => "---").join(" | ") + " |";
  return "| " + headers.join(" | ") + " |\n" + sep + "\n" + rows.map((r) => "| " + r.join(" | ") + " |").join("\n");
}

function buildReport(audit) {
  const zoneById = Object.fromEntries((audit.zones || []).map((z) => [z.id, z]));
  const workerNames = new Set((audit.workers || []).map((w) => w.id ?? w.script_name ?? w.name ?? w).filter(Boolean));
  const pagesNames = new Set((audit.pagesProjects || []).map((p) => p.name ?? p.project_name).filter(Boolean));

  let md = "";
  md += "# Cloudflare Infrastructure Audit Report\n\n";
  md += `**Date:** ${audit.meta.runAt}\n`;
  md += "**Method:** Cloudflare API with CLOUDFLARE_API_TOKEN.\n";
  md += "**Important:** No resources were modified or deleted. Analysis only.\n\n---\n\n";

  // SECTION 1 — ZONES
  md += "## SECTION 1 — ZONES\n\n";
  md += "### 1.1 All zones\n\n";
  if (!audit.zones?.length) {
    md += "*No zones returned by API.*\n\n";
  } else {
    const zoneRows = audit.zones.map((z) => [
      z.name ?? "",
      z.status ?? "",
      (z.plan && z.plan.name) ? z.plan.name : (z.plan ? JSON.stringify(z.plan) : ""),
      (z.name_servers || []).join(", ") || "—",
      z.id ?? "",
    ]);
    md += mdTable(["Name", "Status", "Plan", "Nameservers", "Zone ID"], zoneRows) + "\n\n";
  }

  // SECTION 2 — DNS RECORDS
  md += "## SECTION 2 — DNS RECORDS\n\n";
  for (const zone of audit.zones || []) {
    const zid = zone.id;
    const records = audit.dnsByZone[zid] || [];
    md += `### Zone: ${zone.name} (${zid})\n\n`;
    if (!records.length) {
      md += "*No DNS records.*\n\n";
      continue;
    }
    const dnsRows = records.map((r) => [
      r.type ?? "",
      r.name ?? "",
      (r.content ?? "").slice(0, 60) + ((r.content?.length > 60) ? "…" : ""),
      r.proxied ? "true" : "false",
      String(r.ttl ?? "auto"),
    ]);
    md += mdTable(["Type", "Name", "Content", "Proxied", "TTL"], dnsRows) + "\n\n";
  }
  md += "### 2.1 DNS issues identified\n\n";
  const dnsIssues = [];
  for (const zone of audit.zones || []) {
    const records = audit.dnsByZone[zone.id] || [];
    const names = new Set();
    for (const r of records) {
      const key = `${r.type}:${r.name}`;
      if (names.has(key)) dnsIssues.push({ zone: zone.name, issue: "Duplicate record", detail: `${r.type} ${r.name}` });
      names.add(key);
    }
    for (const r of records) {
      if (r.type === "CNAME" && r.content) {
        const target = r.content.replace(/\.$/, "").toLowerCase();
        if (target.includes("workers.dev") && !workerNames.has(target.split(".")[0])) {
          dnsIssues.push({ zone: zone.name, issue: "CNAME to possible non-existent Worker", detail: r.name + " → " + r.content });
        }
      }
    }
  }
  if (dnsIssues.length) {
    md += mdTable(["Zone", "Issue", "Detail"], dnsIssues.map((i) => [i.zone, i.issue, i.detail])) + "\n\n";
  } else {
    md += "*No duplicate or suspicious DNS records identified from this audit.*\n\n";
  }

  // SECTION 3 — WORKERS
  md += "## SECTION 3 — WORKERS\n\n";
  md += "### 3.1 Worker scripts\n\n";
  if (!audit.workers?.length) {
    md += "*No Workers returned by API.*\n\n";
  } else {
    const workerRows = audit.workers.map((w) => {
      const name = w.id ?? w.script_name ?? w.name ?? w;
      const detail = audit.workerDetails[name];
      const modified = detail?.modified_on ?? detail?.last_modified ?? "—";
      return [name, typeof modified === "string" ? modified.slice(0, 19) : "—"];
    });
    md += mdTable(["Script name", "Last modified"], workerRows) + "\n\n";
  }
  md += "### 3.2 Routes per zone\n\n";
  for (const zone of audit.zones || []) {
    const routes = audit.workerRoutesByZone[zone.id] || [];
    if (!routes.length) continue;
    md += `**${zone.name}:**\n\n`;
    const routeRows = routes.map((r) => [
      r.pattern ?? "",
      r.script ?? "(default)",
      r.id ?? "",
    ]);
    md += mdTable(["Pattern", "Worker script", "Route ID"], routeRows) + "\n\n";
    for (const r of routes) {
      const script = r.script ?? (r.worker && r.worker.script_name) ?? "";
      if (script && !workerNames.has(script)) {
        md += `- **MISCONFIGURED:** Route pattern \`${r.pattern}\` points to script \`${script}\` which was not found in Workers list.\n`;
      }
    }
  }
  const workersWithNoRoutes = (audit.workers || []).filter((w) => {
    const name = w.id ?? w.script_name ?? w.name ?? w;
    const hasRoute = Object.values(audit.workerRoutesByZone || {}).some((routes) =>
      routes.some((r) => (r.script ?? r.worker?.script_name) === name)
    );
    return !hasRoute;
  });
  if (workersWithNoRoutes.length) {
    md += "### 3.3 Workers with no zone routes\n\n";
    md += workersWithNoRoutes.map((w) => "- " + (w.id ?? w.script_name ?? w.name ?? w)).join("\n") + "\n\n";
  }
  md += "### 3.4 Bindings (from Worker details)\n\n";
  for (const name of Object.keys(audit.workerDetails || {})) {
    const d = audit.workerDetails[name];
    if (!d) continue;
    const bindings = d.bindings ?? d.settings?.bindings ?? [];
    if (bindings.length) {
      md += `- **${name}:** ${JSON.stringify(bindings)}\n`;
    }
  }
  if (!Object.keys(audit.workerDetails || {}).some((n) => (audit.workerDetails[n]?.bindings ?? audit.workerDetails[n]?.settings?.bindings ?? []).length)) {
    md += "*Binding details may not be exposed by API; check dashboard or wrangler.toml.*\n\n";
  }

  // SECTION 4 — STORAGE
  md += "## SECTION 4 — STORAGE\n\n";
  const boundD1 = new Set();
  const boundQueues = new Set();
  for (const d of Object.values(audit.workerDetails || {})) {
    if (!d) continue;
    const b = d.bindings ?? d.settings?.bindings ?? [];
    for (const x of b) {
      if (x.type === "d1" && x.database_id) boundD1.add(x.database_id);
      if (x.type === "queue" && x.queue) boundQueues.add(x.queue);
    }
  }
  md += "### 4.1 D1 databases\n\n";
  const d1List = Array.isArray(audit.d1Databases) ? audit.d1Databases : [];
  const d1Rows = d1List.map((d) => [
    d.name ?? "",
    d.uuid ?? d.id ?? "",
    boundD1.has(d.uuid ?? d.id) ? "USED" : "ORPHANED",
  ]);
  if (d1Rows.length) md += mdTable(["Name", "UUID/ID", "Status"], d1Rows) + "\n\n"; else md += "*None or API error.*\n\n";
  md += "### 4.2 Queues\n\n";
  const queueList = Array.isArray(audit.queues) ? audit.queues : [];
  const queueRows = queueList.map((q) => [
    q.name ?? q.queue_name ?? "",
    Array.isArray(q.consumers) && q.consumers.length ? "USED" : "ORPHANED",
  ]);
  if (queueRows.length) md += mdTable(["Name", "Status"], queueRows) + "\n\n"; else md += "*None.*\n\n";

  // SECTION 5 — PAGES
  md += "## SECTION 5 — PAGES\n\n";
  const pagesRows = (audit.pagesProjects || []).map((p) => {
    const name = p.name ?? p.project_name ?? "";
    const detail = audit.pagesProjectDetails[name];
    const domains = detail?.domains ?? p.domains ?? [];
    const domList = Array.isArray(domains) ? domains.join(", ") : (domains && typeof domains === "object" ? Object.keys(domains).join(", ") : "—");
    const repo = (detail?.source?.config?.repo_name ?? p.repo ?? detail?.repo ?? "—") || "—";
    const lastDeploy = detail?.latest_deployment?.created_on ?? p.last_deployment?.created_on ?? "—";
    return [name, domList.slice(0, 80), String(repo).slice(0, 40), typeof lastDeploy === "string" ? lastDeploy.slice(0, 19) : "—"];
  });
  if (pagesRows.length) {
    md += mdTable(["Project", "Custom domains", "Git repo", "Last deployment"], pagesRows) + "\n\n";
  } else {
    md += "*No Pages projects returned.*\n\n";
  }
  md += "### 5.1 Pages without custom domains\n\n";
  const pagesWithoutCustomDomain = (audit.pagesProjects || []).filter((p) => {
    const name = p.name ?? p.project_name ?? "";
    const detail = audit.pagesProjectDetails[name];
    const domains = detail?.domains ?? p.domains ?? [];
    const list = Array.isArray(domains) ? domains : (domains && typeof domains === "object" ? Object.keys(domains) : []);
    return list.filter((d) => d && !String(d).endsWith(".pages.dev")).length === 0;
  });
  if (pagesWithoutCustomDomain.length) {
    md += pagesWithoutCustomDomain.map((p) => "- " + (p.name ?? p.project_name)).join("\n") + "\n\n";
  } else {
    md += "*All projects have at least one custom domain or only .pages.dev.*\n\n";
  }

  // SECTION 6 — ROUTE GRAPH
  md += "## SECTION 6 — ROUTE GRAPH\n\n";
  md += "```\n";
  md += "Domain → DNS → Worker/Page → Storage\n";
  md += "────────────────────────────────────\n";
  for (const zone of audit.zones || []) {
    const routes = audit.workerRoutesByZone[zone.id] || [];
    const records = audit.dnsByZone[zone.id] || [];
    for (const r of routes) {
      const script = r.script ?? r.worker?.script_name ?? "?";
      md += `${zone.name} ${r.pattern} → Worker: ${script}\n`;
    }
    for (const r of records) {
      if (r.type !== "CNAME" && r.type !== "A" && r.type !== "AAAA") continue;
      const target = (r.content || "").replace(/\.$/, "");
      if (target.includes("workers.dev")) md += `${r.name} (${r.type}) → Worker: ${target.split(".")[0]}\n`;
      if (target.includes("pages.dev") || target.includes("pages.dev")) md += `${r.name} (${r.type}) → Pages: ${target}\n`;
    }
  }
  md += "```\n\n";

  // SECTION 7 — CLEANUP CANDIDATES
  md += "## SECTION 7 — CLEANUP CANDIDATES\n\n";
  md += "| Resource | Type | Classification | Notes |\n|----------|------|-----------------|-------|\n";
  for (const z of audit.zones || []) {
    md += `| ${z.name} | Zone | REQUIRED | Primary zone |\n`;
  }
  for (const w of audit.workers || []) {
    const name = w.id ?? w.script_name ?? w.name ?? w;
    const hasRoute = Object.values(audit.workerRoutesByZone || {}).some((routes) =>
      routes.some((r) => (r.script ?? r.worker?.script_name) === name)
    );
    const cls = hasRoute ? "REQUIRED" : "NEEDS REVIEW";
    md += `| ${name} | Worker | ${cls} | ${hasRoute ? "Has route" : "No zone route"} |\n`;
  }
  const d1ListCleanup = Array.isArray(audit.d1Databases) ? audit.d1Databases : [];
  for (const d of d1ListCleanup) {
    const id = d.uuid ?? d.id ?? "";
    const cls = boundD1.has(id) ? "REQUIRED" : "ORPHANED";
    md += `| ${d.name ?? id} | D1 | ${cls} |\n`;
  }
  for (const p of audit.pagesProjects || []) {
    const name = p.name ?? p.project_name ?? "";
    md += `| ${name} | Pages | ACTIVE BUT NON-CRITICAL |\n`;
  }
  md += "\n**Classifications:** REQUIRED | ACTIVE BUT NON-CRITICAL | ORPHANED | MISCONFIGURED | NEEDS REVIEW. Do not delete based on this report alone; verify in dashboard.\n\n";

  if (audit.errors?.length) {
    md += "---\n\n## API errors during audit\n\n";
    for (const e of audit.errors) {
      md += `- ${e.step}: ${e.error}\n`;
    }
  }

  return md;
}

main()
  .then((audit) => {
    audit.meta.tokenPresent = !!token;
    const outDir = join(root, "docs");
    const jsonPath = join(outDir, "cloudflare_audit_data.json");
    const mdPath = join(outDir, "CLOUDFLARE_INFRASTRUCTURE_AUDIT.md");
    writeFileSync(jsonPath, JSON.stringify(audit, null, 2), "utf8");
    const report = buildReport(audit);
    writeFileSync(mdPath, report, "utf8");
    console.error("Wrote:", jsonPath);
    console.error("Wrote:", mdPath);
    console.log(JSON.stringify(audit, null, 2));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
