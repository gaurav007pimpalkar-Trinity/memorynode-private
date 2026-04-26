/**
 * Log-based metrics hooks for the public API → control-plane proxy and control-plane routes.
 * Production alert definitions (Datadog / Loki / Slack / email): `infra/observability/production-alerts.md`.
 * Emit one JSON log line per counter-style event (`metric_kind: "counter"`) for log pipelines
 * (Datadog, Grafana Loki, Cloudflare Logpush) to aggregate into rates and histograms.
 *
 * Suggested alert rules (tune window and thresholds for your stack):
 *
 * 1) Proxy failure rate > 5% (5m window)
 *    - Numerator: count logs where `event` = "control_plane_metric_proxy"
 *      and outcome in ("upstream_5xx", "timeout", "network", "unknown", "circuit_open").
 *    - Denominator: count logs where `event` = "control_plane_metric_proxy" (all outcomes).
 *    - Alert when numerator / denominator > 0.05 for sustained periods.
 *
 * 2) Proxy latency p95 (same `event`, latency_ms on outcome = "ok" or "upstream_4xx").
 *
 * 3) Billing webhook success rate on control-plane (5m):
 *    - success: `event` = "control_plane_metric_billing_webhook" and outcome = "success".
 *    - failure: same `event` and outcome in ("http_5xx", "http_4xx").
 *    - Alert when failures / (success + failures) > 0.05.
 *
 * 4) Admin batch job failures: `event` = "control_plane_metric_admin_job" and outcome = "failed"
 *    vs outcome = "completed" for route = "/admin/webhooks/reprocess".
 */

import { logger } from "./logger.js";

export type ControlPlaneProxyMetricOutcome =
  | "ok"
  | "upstream_4xx"
  | "upstream_5xx"
  | "timeout"
  | "network"
  | "unknown"
  | "circuit_open";

export function logControlPlaneProxyMetric(fields: {
  request_id: string;
  route: string;
  method: string;
  outcome: ControlPlaneProxyMetricOutcome;
  latency_ms: number;
  attempt: number;
  upstream_status?: number;
  failure_reason?: "timeout" | "network" | "unknown";
}): void {
  logger.info({
    event: "control_plane_metric_proxy",
    metric_kind: "counter",
    ...fields,
  });
}

export function logControlPlaneBillingWebhookMetric(fields: {
  request_id: string;
  outcome: "success" | "http_4xx" | "http_5xx" | "deferred";
  status: number;
}): void {
  logger.info({
    event: "control_plane_metric_billing_webhook",
    metric_kind: "counter",
    ...fields,
  });
}

export function logControlPlaneAdminJobMetric(fields: {
  request_id: string | null;
  route: string;
  outcome: "completed" | "failed";
  job?: string;
  detail?: string;
}): void {
  logger.info({
    event: "control_plane_metric_admin_job",
    metric_kind: "counter",
    ...fields,
  });
}
