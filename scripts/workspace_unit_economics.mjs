#!/usr/bin/env node
/**
 * Operator-only workspace unit economics report (v2).
 *
 * For every workspace currently in an active paid entitlement period, compares
 * recognized revenue (base plan + metered overages, same rules as
 * invoice_lines / build_invoice_lines_for_period) to estimated variable cost.
 *
 * Two cost models are supported:
 *
 *  A. Flat (backward compatible, v1)
 *     Used when no model pricing config is provided. Calls SQL function
 *     `list_workspace_billing_cycle_unit_economics(gen, embed, storage)`
 *     with INR-per-token / per-GB rates from env.
 *
 *  B. Model-aware (v2, recommended)
 *     Used when a model pricing config is provided via
 *     ECONOMICS_MODEL_PRICING / --model-pricing FILE. Calls the per-model
 *     aggregator `list_workspace_billing_cycle_token_usage_by_model()` and
 *     applies per-model rates with sensible defaults.
 *
 * On top of either model:
 *   - Infra multiplier (ECONOMICS_INFRA_MULTIPLIER, default 1.4).
 *   - Storage overhead multiplier (ECONOMICS_STORAGE_OVERHEAD, default 1.0).
 *   - Optional calibration drift from actual monthly spend
 *     (ECONOMICS_ACTUAL_MONTHLY_INR), printed always; auto-applied with
 *     ECONOMICS_AUTO_DRIFT=1 / --auto-drift.
 *
 * CLI flags:
 *   --json                 Machine-readable output (full rows + summary).
 *   --top N                Limit "worst margin" list (default 10).
 *   --only-loss-making     Only show rows with adjusted_cost > revenue.
 *   --only-high-risk       Only show rows with adjusted_cost > 0.5 * revenue.
 *   --model-pricing FILE   Path to model pricing JSON (overrides env).
 *   --auto-drift           Multiply adjusted cost by actual/estimated drift.
 *
 * Pricing JSON shape (any of these are accepted):
 *   {
 *     "embedding": { "per_token": 2.24e-7 },
 *     "default_gen": { "input": 4e-5, "output": 8e-5 },
 *     "models": {
 *       "text-embedding-3-small": { "per_token": 2.24e-7 },
 *       "gpt-4o":      { "input": 4e-4, "output": 1.2e-3 },
 *       "gpt-4o-mini": { "input": 1.5e-5, "output": 6e-5 }
 *     },
 *     "storage": { "per_gb": 0.5 }
 *   }
 *
 * All prices are INR per token (or per GB for storage). Use
 * ECONOMICS_*_PER_MILLION env vars in the flat model when you'd rather think
 * in price-per-million.
 *
 * Operator-only. Connects to Postgres via SUPABASE_DB_URL / DATABASE_URL.
 */

import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const USD_TO_INR = Number(process.env.ECONOMICS_USD_TO_INR ?? 83);
const DRIFT = Number(process.env.ECONOMICS_DRIFT_MULTIPLIER ?? 1.35);
const EMBED_USD_PER_1K_DEFAULT = 0.00002;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function defaultEmbedInrPerToken() {
  return (EMBED_USD_PER_1K_DEFAULT / 1000) * USD_TO_INR * DRIFT;
}

function parseArgs(argv) {
  const flags = {
    json: false,
    onlyLoss: false,
    onlyHighRisk: false,
    autoDrift: process.env.ECONOMICS_AUTO_DRIFT === "1",
    top: 10,
    modelPricingFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--only-loss-making") flags.onlyLoss = true;
    else if (a === "--only-high-risk") flags.onlyHighRisk = true;
    else if (a === "--auto-drift") flags.autoDrift = true;
    else if (a === "--top") {
      const next = Number(argv[i + 1]);
      if (Number.isFinite(next) && next > 0) flags.top = Math.floor(next);
      i += 1;
    } else if (a === "--model-pricing") {
      flags.modelPricingFile = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return flags;
}

function loadModelPricing(flags) {
  let raw = null;
  if (flags.modelPricingFile) {
    try {
      raw = fs.readFileSync(path.resolve(flags.modelPricingFile), "utf8");
    } catch (err) {
      fail(`failed to read --model-pricing file: ${err && err.message}`);
    }
  } else if (process.env.ECONOMICS_MODEL_PRICING_FILE) {
    try {
      raw = fs.readFileSync(path.resolve(process.env.ECONOMICS_MODEL_PRICING_FILE), "utf8");
    } catch (err) {
      fail(`failed to read ECONOMICS_MODEL_PRICING_FILE: ${err && err.message}`);
    }
  } else if (process.env.ECONOMICS_MODEL_PRICING) {
    raw = process.env.ECONOMICS_MODEL_PRICING;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("model pricing must be a JSON object");
    }
    return normalizePricing(parsed);
  } catch (err) {
    fail(`invalid model pricing JSON: ${err && err.message}`);
    return null;
  }
}

function normalizePricing(input) {
  // Accepts both the structured form ({ embedding, default_gen, models }) and
  // the flat form ({ "gpt-4": { input, output }, "embedding": { per_token } }).
  const out = {
    embedding: null,
    defaultGen: null,
    storagePerGb: null,
    models: {},
  };
  const lower = (s) => String(s).toLowerCase();

  if (input.embedding && typeof input.embedding === "object") {
    out.embedding = numOrNull(input.embedding.per_token ?? input.embedding.input);
  }
  if (input.default_gen && typeof input.default_gen === "object") {
    out.defaultGen = {
      input: numOrNull(input.default_gen.input),
      output: numOrNull(input.default_gen.output ?? input.default_gen.input),
    };
  }
  if (input.storage && typeof input.storage === "object") {
    out.storagePerGb = numOrNull(input.storage.per_gb);
  }

  const collectModel = (name, val) => {
    if (!val || typeof val !== "object") return;
    if (val.per_token !== undefined) {
      out.models[lower(name)] = { kind: "embed", perToken: numOrNull(val.per_token) };
    } else if (val.input !== undefined || val.output !== undefined) {
      out.models[lower(name)] = {
        kind: "gen",
        input: numOrNull(val.input),
        output: numOrNull(val.output ?? val.input),
      };
    }
  };

  if (input.models && typeof input.models === "object" && !Array.isArray(input.models)) {
    for (const [name, val] of Object.entries(input.models)) collectModel(name, val);
  }
  for (const [name, val] of Object.entries(input)) {
    if (["embedding", "default_gen", "storage", "models"].includes(name)) continue;
    collectModel(name, val);
  }

  return out;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickModelRate(pricing, kind, model) {
  if (!pricing) return null;
  const lc = model ? String(model).toLowerCase() : null;
  if (lc && pricing.models[lc]) {
    const m = pricing.models[lc];
    if (kind === "embed" && m.kind === "embed") return { perToken: m.perToken ?? 0 };
    if (kind !== "embed" && m.kind === "gen") return { input: m.input ?? 0, output: m.output ?? 0 };
  }
  // Loose contains match (e.g. "gpt-4o-2024-05-13" matches "gpt-4o").
  if (lc) {
    for (const [name, val] of Object.entries(pricing.models)) {
      if (lc.includes(name) && ((kind === "embed" && val.kind === "embed") || (kind !== "embed" && val.kind === "gen"))) {
        return val.kind === "embed" ? { perToken: val.perToken ?? 0 } : { input: val.input ?? 0, output: val.output ?? 0 };
      }
    }
  }
  if (kind === "embed") {
    if (pricing.embedding != null) return { perToken: pricing.embedding };
  } else if (pricing.defaultGen) {
    return { input: pricing.defaultGen.input ?? 0, output: pricing.defaultGen.output ?? 0 };
  }
  return null;
}

function validateDbUrl(raw) {
  if (!raw) fail("Missing SUPABASE_DB_URL or DATABASE_URL.");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("Invalid DATABASE_URL / SUPABASE_DB_URL.");
  }
  const host = (parsed.hostname || "").toLowerCase();
  const badHosts = ["host", "example.com", "localhost", "127.0.0.1"];
  const allowLocalDb = process.env.ALLOW_LOCAL_DB_URL === "1";
  const rawLower = raw.toLowerCase();
  if (
    (!allowLocalDb && badHosts.includes(host)) ||
    rawLower.includes("your_") ||
    rawLower.includes("replace_me")
  ) {
    fail(
      `DATABASE_URL looks like a placeholder (${parsed.hostname}). Set a real URL or ALLOW_LOCAL_DB_URL=1 for local Postgres.`,
    );
  }
}

async function fetchFlatEconomics(client, rates) {
  const sql = `
    select *
    from list_workspace_billing_cycle_unit_economics($1::numeric, $2::numeric, $3::numeric)
    order by workspace_name asc
  `;
  const { rows } = await client.query(sql, [rates.gen, rates.embed, rates.storage]);
  return rows;
}

async function fetchModelEconomics(client, rates) {
  const baseSql = `
    select *
    from list_workspace_billing_cycle_unit_economics(0::numeric, 0::numeric, 0::numeric)
    order by workspace_name asc
  `;
  const { rows: baseRows } = await client.query(baseSql);

  const breakdownSql = `select * from list_workspace_billing_cycle_token_usage_by_model()`;
  let breakdownRows = [];
  try {
    const r = await client.query(breakdownSql);
    breakdownRows = r.rows;
  } catch (err) {
    fail(
      `model-aware mode needs migration 065 applied: ${err && err.message}. ` +
        `Run pnpm db:migrate, or omit model pricing to fall back to flat mode.`,
    );
  }
  const byWorkspace = new Map();
  for (const row of breakdownRows) {
    const arr = byWorkspace.get(row.workspace_id) ?? [];
    arr.push(row);
    byWorkspace.set(row.workspace_id, arr);
  }
  return baseRows.map((b) => ({ base: b, breakdown: byWorkspace.get(b.workspace_id) ?? [] }));
}

function computeFlatRow(row, infraMultiplier, storageOverhead, storageRatePerGb) {
  const rev = Number(row.revenue_inr);
  const rawCost = Number(row.estimated_cost_inr);
  const storageGb = Number(row.storage_gb_used) || 0;
  const storageOverheadCost = storageGb * (storageRatePerGb || 0) * Math.max(0, storageOverhead - 1);
  const adjusted = (rawCost + storageOverheadCost) * infraMultiplier;
  return finalize({
    workspace_id: row.workspace_id,
    workspace_name: row.workspace_name,
    plan_code: row.plan_code,
    period_start: row.period_start,
    period_end: row.period_end,
    embed_tokens: Number(row.embed_tokens_used) || 0,
    gen_tokens: Number(row.gen_tokens_used) || 0,
    storage_gb: storageGb,
    revenue_inr: rev,
    raw_cost_inr: rawCost,
    adjusted_cost_inr: adjusted,
    cost_breakdown: { mode: "flat" },
  });
}

function computeModelRow(entry, pricing, infraMultiplier, storageOverhead) {
  const { base, breakdown } = entry;
  const rev = Number(base.revenue_inr);
  let cost = 0;
  let embedTokens = 0;
  let genTokens = 0;
  let storageGb = Number(base.storage_gb_used) || 0;
  const perModel = {};

  for (const r of breakdown) {
    const tokens = Number(r.tokens) || 0;
    const kind = r.kind;
    const model = r.model || "(unspecified)";
    const key = `${kind}:${model}`;
    if (kind === "embed") {
      embedTokens += tokens;
      const rate = pickModelRate(pricing, "embed", r.model);
      const perToken = rate?.perToken ?? 0;
      const lineCost = tokens * perToken;
      cost += lineCost;
      perModel[key] = (perModel[key] ?? 0) + lineCost;
    } else if (kind === "gen_input") {
      genTokens += tokens;
      const rate = pickModelRate(pricing, "gen", r.model);
      const perToken = rate?.input ?? 0;
      const lineCost = tokens * perToken;
      cost += lineCost;
      perModel[key] = (perModel[key] ?? 0) + lineCost;
    } else if (kind === "gen_output") {
      genTokens += tokens;
      const rate = pickModelRate(pricing, "gen", r.model);
      const perToken = rate?.output ?? 0;
      const lineCost = tokens * perToken;
      cost += lineCost;
      perModel[key] = (perModel[key] ?? 0) + lineCost;
    }
  }

  const storageRate = pricing?.storagePerGb ?? 0;
  const storageBaseCost = storageGb * storageRate;
  const storageOverheadCost = storageBaseCost * Math.max(0, storageOverhead - 1);
  cost += storageBaseCost + storageOverheadCost;

  const adjusted = cost * infraMultiplier;

  return finalize({
    workspace_id: base.workspace_id,
    workspace_name: base.workspace_name,
    plan_code: base.plan_code,
    period_start: base.period_start,
    period_end: base.period_end,
    embed_tokens: embedTokens || Number(base.embed_tokens_used) || 0,
    gen_tokens: genTokens || Number(base.gen_tokens_used) || 0,
    storage_gb: storageGb,
    revenue_inr: rev,
    raw_cost_inr: cost,
    adjusted_cost_inr: adjusted,
    cost_breakdown: { mode: "model-aware", per_model: perModel },
  });
}

function finalize(row) {
  const rev = Number(row.revenue_inr);
  const adjusted = Number(row.adjusted_cost_inr);
  const costPct = rev > 0 ? (adjusted / rev) * 100 : null;
  const margin = rev > 0 ? rev - adjusted : null;
  const marginPct = rev > 0 ? ((rev - adjusted) / rev) * 100 : null;
  return {
    ...row,
    raw_cost_inr: round6(row.raw_cost_inr),
    adjusted_cost_inr: round6(adjusted),
    cost_pct_of_revenue: costPct == null ? null : round4(costPct),
    margin_inr: margin == null ? null : round6(margin),
    margin_pct: marginPct == null ? null : round4(marginPct),
    high_risk_flag: rev > 0 ? adjusted > rev * 0.5 : false,
    loss_flag: rev > 0 ? adjusted > rev : false,
  };
}

function round4(n) {
  return Number(Number(n).toFixed(4));
}
function round6(n) {
  return Number(Number(n).toFixed(6));
}

function applyDrift(rows, drift) {
  if (!Number.isFinite(drift) || drift <= 0) return rows;
  return rows.map((r) => {
    const adjusted = r.adjusted_cost_inr * drift;
    return finalize({
      ...r,
      raw_cost_inr: r.raw_cost_inr,
      adjusted_cost_inr: adjusted,
      revenue_inr: r.revenue_inr,
    });
  });
}

function sortByWorstMargin(rows) {
  return [...rows].sort((a, b) => {
    const am = a.margin_pct;
    const bm = b.margin_pct;
    if (am === null && bm === null) return 0;
    if (am === null) return 1;
    if (bm === null) return -1;
    return am - bm; // ascending: smallest (worst) first
  });
}

function applyFilters(rows, flags) {
  let out = rows;
  if (flags.onlyLoss) out = out.filter((r) => r.loss_flag);
  if (flags.onlyHighRisk) out = out.filter((r) => r.high_risk_flag);
  return out;
}

function printText({ rows, top, summary, mode, unitCosts, calibration, warnings }) {
  console.log(`Mode: ${mode}`);
  if (mode === "flat") {
    console.log(
      `  Flat rates: gen INR/token=${unitCosts.gen}  embed INR/token=${unitCosts.embed}  storage INR/GB=${unitCosts.storage}`,
    );
  } else {
    console.log(`  Model pricing loaded from ${unitCosts.source} (${unitCosts.modelCount} models).`);
    console.log(`  Storage INR/GB: ${unitCosts.storagePerGb ?? 0}`);
  }
  console.log(`  Infra multiplier: ${summary.infra_multiplier}  Storage overhead: ${summary.storage_overhead}`);
  if (calibration) {
    console.log(
      `Calibration: actual ₹${calibration.actual_monthly_inr} vs estimated ₹${calibration.estimated_monthly_inr} ` +
        `→ drift x${calibration.drift_factor}${calibration.applied ? " (APPLIED)" : ""}`,
    );
  }
  console.log(
    `Workspaces in active period: ${summary.total_workspaces} ` +
      `(loss ${summary.loss_count}, high-risk ${summary.high_risk_count})`,
  );
  console.log("");

  for (const w of warnings) console.log(w);
  if (warnings.length > 0) console.log("");

  console.log(`Top ${top.length} worst-margin workspaces:`);
  if (top.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of top) {
      console.log(
        [
          r.workspace_name,
          r.plan_code,
          r.margin_pct != null ? `margin=${r.margin_pct}%` : "margin=n/a",
          `rev=₹${r.revenue_inr}`,
          `cost=₹${r.adjusted_cost_inr}`,
          `cost%=${r.cost_pct_of_revenue ?? "n/a"}%`,
          r.loss_flag ? "LOSS" : r.high_risk_flag ? "HIGH-RISK" : "",
        ]
          .filter(Boolean)
          .join(" | "),
      );
    }
  }
  console.log("");
  console.log("All workspaces (sorted by worst margin):");
  for (const r of rows) {
    console.log(
      [
        r.workspace_name,
        r.plan_code,
        `rev ₹${r.revenue_inr}`,
        `raw ₹${r.raw_cost_inr}`,
        `adj ₹${r.adjusted_cost_inr}`,
        r.margin_pct != null ? `margin ${r.margin_pct}%` : "margin n/a",
        r.loss_flag ? "LOSS" : r.high_risk_flag ? "HIGH-RISK" : "",
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  validateDbUrl(dbUrl);

  const pricing = loadModelPricing(flags);
  const infraMultiplier = numEnv("ECONOMICS_INFRA_MULTIPLIER", 1.4);
  const storageOverhead = numEnv("ECONOMICS_STORAGE_OVERHEAD", 1.0);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  let rows = [];
  let mode = "flat";
  let unitCosts = null;

  if (pricing) {
    mode = "model-aware";
    const entries = await fetchModelEconomics(client, {});
    rows = entries.map((e) => computeModelRow(e, pricing, infraMultiplier, storageOverhead));
    unitCosts = {
      source: flags.modelPricingFile ?? process.env.ECONOMICS_MODEL_PRICING_FILE ?? "ECONOMICS_MODEL_PRICING env",
      modelCount: Object.keys(pricing.models).length,
      storagePerGb: pricing.storagePerGb,
    };
  } else {
    let gen = numEnv("ECONOMICS_GEN_INR_PER_TOKEN", 0);
    let embed = numEnv("ECONOMICS_EMBED_INR_PER_TOKEN", defaultEmbedInrPerToken());
    const storage = numEnv("ECONOMICS_STORAGE_INR_PER_GB", 0);
    const genPerM = process.env.ECONOMICS_GEN_INR_PER_MILLION;
    if (genPerM) {
      const n = Number(genPerM);
      if (Number.isFinite(n)) gen = n / 1_000_000;
    }
    const embedPerM = process.env.ECONOMICS_EMBED_INR_PER_MILLION;
    if (embedPerM) {
      const n = Number(embedPerM);
      if (Number.isFinite(n)) embed = n / 1_000_000;
    }
    unitCosts = { gen, embed, storage };
    const flatRows = await fetchFlatEconomics(client, { gen, embed, storage });
    rows = flatRows.map((r) => computeFlatRow(r, infraMultiplier, storageOverhead, storage));
  }

  await client.end();

  let estimatedMonthlyTotal = rows.reduce((acc, r) => acc + Number(r.adjusted_cost_inr || 0), 0);
  const actualMonthly = numEnv("ECONOMICS_ACTUAL_MONTHLY_INR", null);
  let calibration = null;
  if (actualMonthly !== null && Number.isFinite(actualMonthly) && actualMonthly > 0) {
    const drift = estimatedMonthlyTotal > 0 ? actualMonthly / estimatedMonthlyTotal : null;
    if (drift !== null && flags.autoDrift) {
      rows = applyDrift(rows, drift);
      estimatedMonthlyTotal = rows.reduce((acc, r) => acc + Number(r.adjusted_cost_inr || 0), 0);
    }
    calibration = {
      actual_monthly_inr: actualMonthly,
      estimated_monthly_inr: round6(estimatedMonthlyTotal),
      drift_factor: drift == null ? null : round4(drift),
      applied: flags.autoDrift,
    };
  }

  const filtered = applyFilters(rows, flags);
  const sorted = sortByWorstMargin(filtered);
  const top = sorted.slice(0, flags.top);

  const summary = {
    mode,
    total_workspaces: filtered.length,
    loss_count: filtered.filter((r) => r.loss_flag).length,
    high_risk_count: filtered.filter((r) => r.high_risk_flag).length,
    estimated_monthly_inr: round6(estimatedMonthlyTotal),
    infra_multiplier: infraMultiplier,
    storage_overhead: storageOverhead,
  };

  const warnings = [];
  if (summary.loss_count > 0)
    warnings.push(`CRIT: ${summary.loss_count} workspace(s) cost more than they pay (LOSS).`);
  if (summary.high_risk_count > summary.loss_count)
    warnings.push(`WARN: ${summary.high_risk_count - summary.loss_count} workspace(s) at >50% cost ratio (HIGH-RISK).`);
  if (mode === "flat" && pricing == null)
    warnings.push("INFO: running in flat mode; consider --model-pricing for accuracy.");
  if (!calibration)
    warnings.push("INFO: set ECONOMICS_ACTUAL_MONTHLY_INR to calibrate against your real bill.");

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          summary,
          unit_costs: unitCosts,
          calibration,
          warnings,
          rows: sorted,
          top: top,
        },
        null,
        2,
      ),
    );
    return;
  }

  printText({
    rows: sorted,
    top,
    summary,
    mode,
    unitCosts,
    calibration,
    warnings,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
