#!/usr/bin/env node
/**
 * Cross-platform release gate runner (no DB mutation).
 * Required checks:
 *   - lint, typecheck, test
 *   - migrations:check
 *   - secrets scans (env + tracked files)
 * Optional:
 *   - build when RELEASE_INCLUDE_BUILD=1
 *
 * When RELEASE_GATE_LIVE=1 and BASE_URL is https, also verifies deployed API health
 * and basic dashboard env alignment (staging vs production).
 *
 * Staging API-only deploys: set RELEASE_GATE_SKIP_DASHBOARD=1 to skip VITE_/dashboard
 * checks while still running /healthz, /ready, GET /v1/usage/today (staging only).
 *
 * Release Staging workflow intentionally omits RELEASE_GATE_LIVE so a broken staging Worker
 * cannot block deploying the fix; deploy_staging.mjs still verifies /healthz after upload.
 */

import { execSync } from "node:child_process";

const inferredCheckEnv = process.env.CHECK_ENV ?? (process.env.CI ? "staging" : "production");
const childEnv = { ...process.env, CHECK_ENV: inferredCheckEnv };

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: childEnv });
}

async function runLiveReleaseGate() {
  if ((process.env.RELEASE_GATE_LIVE ?? "").trim() !== "1") {
    return;
  }

  const baseRaw = (process.env.BASE_URL ?? "").trim();
  if (!baseRaw.startsWith("http")) {
    throw new Error("[release-gate-live] RELEASE_GATE_LIVE=1 requires BASE_URL (https URL)");
  }
  const base = baseRaw.replace(/\/+$/, "");
  const timeoutMs = Math.min(
    Math.max(parseInt(process.env.RELEASE_GATE_HTTP_TIMEOUT_MS || "20000", 10) || 20000, 3000),
    120000,
  );

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for (const path of ["/healthz", "/ready"]) {
      const url = `${base}${path}`;
      const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
      if (!res.ok) {
        throw new Error(
          `[release-gate-live] ${path} → HTTP ${res.status} (${url}) — fix API health or BASE_URL before deploy`,
        );
      }
    }
  } finally {
    clearTimeout(t);
  }

  /** Strip CR/newlines — GitHub Environment secrets often pad keys and break Bearer auth. */
  const gateKey = String(process.env.MEMORYNODE_API_KEY || process.env.E2E_API_KEY || "")
    .replace(/\r/g, "")
    .trim();
  if (!gateKey) {
    throw new Error(
      "[release-gate-live] MEMORYNODE_API_KEY (or E2E_API_KEY) is required for authenticated API check — add to the staging/production GitHub Environment",
    );
  }
  const usageUrl = `${base}/v1/usage/today`;
  const acUsage = new AbortController();
  const tUsage = setTimeout(() => acUsage.abort(), Math.min(timeoutMs, 15000));
  try {
    const ures = await fetch(usageUrl, {
      signal: acUsage.signal,
      redirect: "follow",
      headers: { Authorization: `Bearer ${gateKey}`, Accept: "application/json" },
    });
    const usageBodyText = await ures.text();
    let usagePayload = /** @type {Record<string, unknown> | null} */ (null);
    try {
      usagePayload = JSON.parse(usageBodyText);
    } catch {
      usagePayload = null;
    }
    const errObj = usagePayload && typeof usagePayload === "object" ? /** @type {{ error?: { code?: string } }} */ (usagePayload).error : undefined;
    /** Workspace has no paid entitlement — auth still succeeded (handlers/usage.ts). */
    const entitlementBlocked = ures.status === 402 && errObj?.code === "ENTITLEMENT_REQUIRED";

    if (!ures.ok && !entitlementBlocked) {
      throw new Error(
        `[release-gate-live] GET /v1/usage/today → HTTP ${ures.status} (${usageUrl}) — verify MEMORYNODE_API_KEY and API auth (${usageBodyText.slice(0, 200)})`,
      );
    }
    if (!ures.ok && entitlementBlocked) {
      console.warn(
        `[release-gate-live] GET /v1/usage/today → HTTP ${ures.status} (${errObj?.code ?? "billing"}) — key is authenticated; entitlement/cap gate only (acceptable for release gate).`,
      );
    }
  } finally {
    clearTimeout(tUsage);
  }

  const checkEnv = (process.env.CHECK_ENV ?? "").trim().toLowerCase();
  const skipDashboardStaging =
    (process.env.RELEASE_GATE_SKIP_DASHBOARD ?? "").trim() === "1" && checkEnv === "staging";

  if (skipDashboardStaging) {
    console.log(
      "[release-gate-live] OK: /healthz, /ready, GET /v1/usage/today (dashboard alignment skipped — RELEASE_GATE_SKIP_DASHBOARD=1)",
    );
    return;
  }

  const viteApi = (process.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const viteConsole = (process.env.VITE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");

  if (viteApi) {
    if (checkEnv === "staging" && viteApi !== base) {
      throw new Error(
        `[release-gate-live] staging: VITE_API_BASE_URL (${viteApi}) must equal BASE_URL (${base}) — dashboard would call the wrong API`,
      );
    }
    if (checkEnv === "production") {
      const expected = "https://api.memorynode.ai";
      if (viteApi !== expected) {
        throw new Error(`[release-gate-live] production: VITE_API_BASE_URL must be ${expected}, got ${viteApi}`);
      }
    }
  }

  if (checkEnv === "production") {
    const expC = "https://console.memorynode.ai";
    if (!viteConsole.startsWith("http")) {
      throw new Error(
        "[release-gate-live] production: VITE_CONSOLE_BASE_URL must be set — required for dashboard build parity",
      );
    }
    if (viteConsole !== expC) {
      throw new Error(
        `[release-gate-live] production: VITE_CONSOLE_BASE_URL must be ${expC}, got ${viteConsole} — wrong console origin for prod dashboard`,
      );
    }
  } else if (checkEnv === "staging") {
    if (!viteConsole.startsWith("https://")) {
      throw new Error(
        "[release-gate-live] staging: VITE_CONSOLE_BASE_URL must be an https URL — set in staging environment",
      );
    }
  }

  const dashUrl = (process.env.VITE_SUPABASE_URL ?? "").trim();
  const dashKey = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
  if (checkEnv === "production" || checkEnv === "staging") {
    if (!dashUrl.startsWith("http")) {
      throw new Error("[release-gate-live] VITE_SUPABASE_URL must be set for dashboard builds in this environment");
    }
    if (dashKey.length < 20) {
      throw new Error("[release-gate-live] VITE_SUPABASE_ANON_KEY looks missing or too short");
    }
  }

  console.log("[release-gate-live] OK: /healthz, /ready, GET /v1/usage/today, dashboard URL alignment");
}

async function main() {
  const checks = [
    "pnpm check:workspace-scripts",
    "pnpm check:tracked-artifacts",
    "pnpm check:typed-entry",
    "pnpm check:workspace-scope",
    "pnpm check:observability-contracts",
    "pnpm check:runbooks",
    "pnpm check:least-privilege",
    "pnpm check:wrangler",
    "pnpm check:config",
    "pnpm check:economics-gate",
    "pnpm secrets:check",
    "pnpm secrets:check:tracked",
    "pnpm migrations:check",
    "pnpm openapi:check",
    "pnpm -w lint",
    "pnpm -w typecheck",
    "pnpm -w test",
  ];
  if ((process.env.RELEASE_INCLUDE_BUILD ?? "").trim() === "1") {
    checks.push("pnpm -w build");
  }
  for (const cmd of checks) {
    run(cmd);
  }
  await runLiveReleaseGate();
}

main().catch((err) => {
  if (err && typeof err.status === "number") process.exit(err.status);
  console.error(err?.message || err);
  process.exit(1);
});
