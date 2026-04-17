#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const plansTsPath = path.join(root, "packages", "shared", "src", "plans.ts");
const costModelTsPath = path.join(root, "packages", "shared", "src", "costModel.ts");
const thresholdsPath = path.join(root, "scripts", "economics_thresholds.json");

function transpileTsFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

function evaluateCommonJs(transpiled, requireFn) {
  const context = {
    module: { exports: {} },
    exports: {},
    require: requireFn,
  };
  context.exports = context.module.exports;
  vm.createContext(context);
  vm.runInContext(transpiled, context);
  return context.module.exports;
}

function loadModules() {
  const costModelTranspiled = transpileTsFile(costModelTsPath);
  const costModel = evaluateCommonJs(costModelTranspiled, () => {
    throw new Error("Unexpected require() while loading costModel.ts");
  });

  const plansTranspiled = transpileTsFile(plansTsPath);
  const plans = evaluateCommonJs(plansTranspiled, (specifier) => {
    if (specifier === "./costModel.js" || specifier === "./costModel") {
      return costModel;
    }
    throw new Error(`Unexpected require() while loading plans.ts: ${specifier}`);
  });

  return { plansById: plans.PLANS_BY_ID ?? {}, costModel };
}

function loadThresholds(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function estimateWorstCasePlanCostInr(plan, costModel) {
  const limits = plan.limits ?? {};
  const writes = Number(limits.included_writes ?? limits.writes_per_day ?? 0);
  const reads = Number(limits.included_reads ?? limits.reads_per_day ?? 0);
  const embedTokens = Number(limits.included_embed_tokens ?? limits.embed_tokens_per_day ?? 0);
  const extractionCalls = Number(limits.extraction_calls_per_day ?? 0);
  const genTokens = Number(limits.included_gen_tokens ?? 0);
  const storageGb = Number(limits.included_storage_gb ?? 0);
  const total = Number(
    costModel.estimateCostInr({
      writes,
      reads,
      embed_tokens: embedTokens,
      extraction_calls: extractionCalls,
      gen_tokens: genTokens,
      storage_gb: storageGb,
    }),
  );

  return {
    total: Number(total.toFixed(2)),
    breakdown: {
      writes,
      reads,
      embed_tokens: embedTokens,
      extraction_calls: extractionCalls,
      gen_tokens: genTokens,
      storage_gb: storageGb,
    },
  };
}

function main() {
  const { plansById, costModel } = loadModules();
  const thresholds = loadThresholds(thresholdsPath);
  const planIds = Object.keys(thresholds.plan_thresholds ?? {});
  if (planIds.length === 0) {
    console.error("economics gate misconfigured: no plan thresholds found");
    process.exit(1);
  }

  const failures = [];
  const rows = [];
  for (const planId of planIds) {
    const plan = plansById[planId];
    if (!plan) {
      failures.push(`missing plan in shared config: ${planId}`);
      continue;
    }
    const planPrice = Number(plan.price_inr ?? 0);
    const estimation = estimateWorstCasePlanCostInr(plan, costModel);
    const ratioPct = planPrice > 0 ? Number(((estimation.total / planPrice) * 100).toFixed(2)) : 0;

    const perPlanThreshold = thresholds.plan_thresholds[planId] ?? {};
    const fixedLimit = Number(perPlanThreshold.fixed_inr ?? Number.POSITIVE_INFINITY);
    const marginLimitPct = Number(perPlanThreshold.max_cost_ratio_pct ?? Number.POSITIVE_INFINITY);
    const fixedBreached = Number.isFinite(fixedLimit) && estimation.total > fixedLimit;
    const marginBreached = Number.isFinite(marginLimitPct) && ratioPct > marginLimitPct;

    rows.push({
      planId,
      planPrice,
      estimatedWorstCaseInr: estimation.total,
      costToPricePct: ratioPct,
      fixedLimit,
      marginLimitPct,
      fixedBreached,
      marginBreached,
    });

    if (fixedBreached || marginBreached) {
      failures.push(
        `${planId}: estimated=${estimation.total} INR, price=${planPrice} INR, ratio=${ratioPct}% (fixed<=${fixedLimit}, ratio<=${marginLimitPct}%)`,
      );
    }
  }

  console.log("Economics gate report");
  for (const row of rows) {
    console.log(
      `- ${row.planId}: est=${row.estimatedWorstCaseInr} INR | price=${row.planPrice} INR | ratio=${row.costToPricePct}% | fixed<=${row.fixedLimit} | ratio<=${row.marginLimitPct}%`,
    );
  }

  if (failures.length > 0) {
    console.error("\nEconomics gate FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nEconomics gate passed.");
}

main();
