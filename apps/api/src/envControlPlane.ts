import type { Env } from "./env.js";
import { getEnvironmentStage } from "./env.js";

let validatedPublicWorkerEnv = false;
let validatedControlPlaneWorkerEnv = false;

/**
 * First-request (isolate cold-start) validation for the public API Worker.
 * Staging/prod: requires CONTROL_PLANE_ORIGIN and CONTROL_PLANE_SECRET so `/v1/admin/*` proxy can run.
 * Dev: skipped so local single-worker workflows keep working.
 */
export function assertPublicWorkerControlPlaneEnvOnce(env: Env): void {
  if (validatedPublicWorkerEnv) return;
  const stage = getEnvironmentStage(env);
  if (stage === "dev") {
    validatedPublicWorkerEnv = true;
    return;
  }
  const origin = (env.CONTROL_PLANE_ORIGIN ?? "").trim();
  const secret = (env.CONTROL_PLANE_SECRET ?? "").trim();
  if (!origin || !secret) {
    throw new Error(
      "Public API Worker (staging/prod): CONTROL_PLANE_ORIGIN and CONTROL_PLANE_SECRET must be set (wrangler secrets/vars).",
    );
  }
  validatedPublicWorkerEnv = true;
}

/**
 * First-request validation for the control-plane Worker.
 * Staging/prod: CONTROL_PLANE_SECRET is mandatory for ingress.
 */
export function assertControlPlaneWorkerSecretOnce(env: Env): void {
  if (validatedControlPlaneWorkerEnv) return;
  const stage = getEnvironmentStage(env);
  if (stage === "dev") {
    validatedControlPlaneWorkerEnv = true;
    return;
  }
  if (!(env.CONTROL_PLANE_SECRET ?? "").trim()) {
    throw new Error("control-plane Worker (staging/prod): CONTROL_PLANE_SECRET must be set.");
  }
  validatedControlPlaneWorkerEnv = true;
}
