import { trialExpiredBlocksWrites } from "@memorynodeai/shared";
import type { AuthContext } from "./auth.js";
import type { Env } from "./env.js";

export function trialExpiredWritesPayload(env: Env): {
  error: { code: "TRIAL_EXPIRED"; message: string; upgrade_required: true };
  upgrade_url?: string;
} {
  const baseUrl = env.PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";
  return {
    error: {
      code: "TRIAL_EXPIRED",
      message:
        "Your MemoryNode trial has ended. Add a payment method to continue creating or changing data.",
      upgrade_required: true,
    },
    ...(baseUrl ? { upgrade_url: `${baseUrl}/billing` } : {}),
  };
}

/** Returns 402 when the workspace trial has ended and writes must be blocked (reads still allowed). */
export function maybeRespondTrialExpiredWrite(
  auth: AuthContext,
  env: Env,
  jsonResponse: (data: unknown, status?: number, headers?: Record<string, string>) => Response,
  headers?: Record<string, string>,
): Response | null {
  if (!trialExpiredBlocksWrites(auth)) return null;
  return jsonResponse(trialExpiredWritesPayload(env), 402, headers);
}
