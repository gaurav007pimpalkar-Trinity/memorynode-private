/**
 * Control-plane Cloudflare Worker entry: PayU billing webhook, `/admin/*`, `/v1/admin/*`.
 * Deploy separately from the public API Worker (`src/index.ts`).
 *
 * Ingress: `handleControlPlaneRequest` enforces `x-internal-secret` === `CONTROL_PLANE_SECRET`
 * on gated paths (see `controlPlaneSecurity.ts`). Health routes are excluded.
 *
 * Optional scheduled retry: set `WEBHOOK_AUTO_REPROCESS=1` and configure `triggers.crons` in
 * `apps/control-plane/wrangler.toml` to periodically POST `/admin/webhooks/reprocess?status=all_retryable`.
 */

import type { Env } from "./env.js";
import { CircuitBreakerDO } from "./circuitBreakerDO.js";
import { handleControlPlaneRequest } from "./workerApp.js";
import { logger } from "./logger.js";
import { RateLimitDO } from "./rateLimitDO.js";

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleControlPlaneRequest(request, env);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (String(env.WEBHOOK_AUTO_REPROCESS ?? "").trim() !== "1") {
      return;
    }
    const secret = (env.CONTROL_PLANE_SECRET ?? "").trim();
    const admin = (env.MASTER_ADMIN_TOKEN ?? "").trim();
    if (!secret || !admin) {
      logger.info({
        event: "webhook_scheduled_reprocess_skipped",
        reason: "missing_control_plane_secret_or_master_admin_token",
      });
      return;
    }
    const req = new Request(
      "https://control-plane.internal/admin/webhooks/reprocess?status=all_retryable&limit=40",
      {
        method: "POST",
        headers: {
          "x-internal-secret": secret,
          "x-admin-token": admin,
          "cf-connecting-ip": "127.0.0.1",
          "x-request-id": `cron-${Date.now()}`,
        },
      },
    );
    const res = await handleControlPlaneRequest(req, env);
    logger.info({
      event: "webhook_scheduled_reprocess_run",
      metric_kind: "counter",
      status: res.status,
    });
  },

  RateLimitDO,
  CircuitBreakerDO,
};

export default worker;
export { RateLimitDO, CircuitBreakerDO, handleControlPlaneRequest };
