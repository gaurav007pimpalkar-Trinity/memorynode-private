import type { Env } from "./env.js";
import { getEnvironmentStage } from "./env.js";

let validatedControlPlaneWorkerEnv = false;

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
