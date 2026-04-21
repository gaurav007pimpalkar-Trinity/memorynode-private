import { trialExpiredBlocksWrites } from "@memorynodeai/shared";
import type { HostedBrandedDeps } from "../adapters/hosted.js";
import { toolError } from "./policyResponses.js";

/** MCP tool result when trial ended and the tool would mutate server-side state. */
export function trialExpiredWriteToolResult(deps: HostedBrandedDeps) {
  if (!trialExpiredBlocksWrites(deps.auth)) return null;
  const raw =
    deps.env && typeof deps.env === "object" && "PUBLIC_APP_URL" in deps.env
      ? (deps.env as { PUBLIC_APP_URL?: string }).PUBLIC_APP_URL
      : undefined;
  const baseUrl = typeof raw === "string" ? raw.trim().replace(/\/$/, "") : "";
  return toolError(
    "TRIAL_EXPIRED",
    "Your MemoryNode trial has ended. Add a payment method to continue creating or changing data.",
    {
      upgrade_required: true,
      ...(baseUrl ? { upgrade_url: `${baseUrl}/billing` } : {}),
    },
  );
}
