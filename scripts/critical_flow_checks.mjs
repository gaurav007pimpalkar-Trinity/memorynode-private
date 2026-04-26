#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function runStep(label, command) {
  console.log(`\n[critical:flows] ${label}`);
  console.log(`[critical:flows] $ ${command}`);
  const res = spawnSync(command, { stdio: "inherit", shell: true, env: process.env });
  if ((res.status ?? 1) !== 0) {
    console.error(`\n[critical:flows] FAIL at step: ${label}`);
    process.exit(res.status ?? 1);
  }
}

function main() {
  runStep(
    "billing callback status handling",
    "pnpm --filter @memorynode/dashboard exec vitest run tests/billing_return_status.test.ts",
  );
  runStep(
    "dashboard session auth + csrf primitives",
    "pnpm --filter @memorynode/api exec vitest run --root ../.. apps/api/tests/dashboard_session.test.ts apps/api/tests/retry_behavior.test.ts",
  );
  runStep(
    "memory create/search roundtrip",
    "pnpm --filter @memorynode/api exec vitest run --root ../.. apps/api/tests/api_key_roundtrip.test.ts",
  );
  console.log("\n[critical:flows] PASS");
}

main();

