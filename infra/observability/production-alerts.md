# Production alerts (log / metrics)

Workers emit JSON logs with `event_name` (see `logger.ts`). Metrics use `event` = `control_plane_metric_proxy` | `control_plane_metric_billing_webhook` | `control_plane_metric_admin_job` (see `controlPlaneMetrics.ts`). Circuit events use `event_name` = `circuit_breaker_open` | `circuit_breaker_closed` with `circuit` and `open_until_epoch_ms` on open.

Delivery: wire **Slack Incoming Webhook** or **email** via your provider’s notification channel (below: Datadog native; Grafana Alertmanager for Loki/Prometheus).

---

## 1) Control-plane proxy: bad outcomes > 5% over 5 minutes

**Signal:** `event_name = "control_plane_metric_proxy"` (or `event` if your pipeline maps it). Treat **failure** as `outcome != "ok"` (includes `upstream_4xx`, `upstream_5xx`, `timeout`, `network`, `unknown`, `circuit_open`).

### Datadog (Log Monitor)

- **Query:** Log search  
  `@event_name:control_plane_metric_proxy`  
  (or `@event:control_plane_metric_proxy` if you index the inner field.)

- **Formula (5m rolling):**  
  `a = count(outcome != "ok")`  
  `b = count(*)`  
  **Alert:** `a / max(b, 1) > 0.05` for **5 consecutive minutes** (or single window 5m: `a/b > 0.05`).

- **Notification:** Team → **Slack** integration or **Email** in monitor “Notify your team”.

### Grafana Loki + Alertmanager

```yaml
groups:
  - name: memorynode-control-plane
    interval: 1m
    rules:
      - alert: ControlPlaneProxyErrorRateHigh
        expr: |
          sum(count_over_time({job="memorynode-api"} | json | event_name="control_plane_metric_proxy" | outcome != "ok" [5m]))
          /
          sum(count_over_time({job="memorynode-api"} | json | event_name="control_plane_metric_proxy" [5m]))
          > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "control_plane_metric_proxy failure rate >5% over 5m"
```

**Alertmanager** `receivers`:

```yaml
receivers:
  - name: slack
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/XXX/YYY/ZZZ'
        channel: '#alerts'
        title: '{{ .CommonAnnotations.summary }}'
  - name: email
    email_configs:
      - to: 'oncall@example.com'
        from: 'alertmanager@example.com'
        smarthost: 'smtp.example.com:587'
        auth_username: 'alertmanager'
        auth_password: '<secret>'
```

Route `match: { alertname: ControlPlaneProxyErrorRateHigh }` → `slack` or `email`.

---

## 2) Billing webhook: success rate below 95% (5m)

**Signal:** `event_name = "control_plane_metric_billing_webhook"` with `outcome` in `success` | `http_4xx` | `http_5xx` | `deferred`. Treat **success** as `outcome == "success"` (exclude deferred from denominator if you only care PayU acceptance; below includes all non-server-error as “ok” for ops—tune as needed).

**Recommended denominator:** `outcome in (success, http_4xx, http_5xx)` (exclude `deferred` from SLA if product treats 202 as healthy backlog).

**Alert:** `success_count / denominator < 0.95` over **5m**.

### Datadog

- Log monitor:  
  `a = count(@outcome:success)`  
  `b = count(@outcome:(success OR http_4xx OR http_5xx))`  
  Alert: `a / max(b,1) < 0.95` for 5m.

### Grafana Loki

```yaml
      - alert: BillingWebhookSuccessRateLow
        expr: |
          sum(count_over_time({job="memorynode-control-plane"} | json | event_name="control_plane_metric_billing_webhook" | outcome="success" [5m]))
          /
          sum(count_over_time({job="memorynode-control-plane"} | json | event_name="control_plane_metric_billing_webhook" | outcome=~"success|http_4xx|http_5xx" [5m]))
          < 0.95
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Billing webhook success rate <95% (5m)"
```

---

## 3) Circuit breaker open longer than 1 minute

**Signals:**

- `event_name:circuit_breaker_open` includes **`open_until_epoch_ms`** (Unix ms when the breaker is scheduled to leave the open state) and **`circuit`** (`openai` | `supabase` | `control_plane_proxy`).
- `event_name:circuit_breaker_closed` with same **`circuit`** when a probe succeeds.

**Option A — Sustained client impact (simple):**  
Alert if **`control_plane_metric_proxy`** with **`outcome:circuit_open`** **count ≥ N** in **2m** (e.g. N=5): users still see 503s while the circuit is open or immediately reopening.

**Option B — Open window exceeded (log math):**  
For each `circuit_breaker_open`, alert if **current time > `open_until_epoch_ms` + 60_000`** and there is **no** `circuit_breaker_closed` for that `circuit` with timestamp after `open_until_epoch_ms`. Implement with a **composite** / **sequence** monitor (Datadog composite; Grafana with recording rules joining on `circuit`).

**Option C — Metric exporter:** If you export DO state to Prometheus, alert `circuit_breaker_open_gauge{circuit="control_plane_proxy"} == 1` for **>1m** (requires extra instrumentation; not in repo today).

**Slack / email:** Same Alertmanager or Datadog channels as above.

---

## Provider quick reference

| Provider   | Alert type        | Slack                         | Email              |
|-----------|-------------------|-------------------------------|--------------------|
| Datadog   | Log monitor       | @slack-channel in monitor     | @email in monitor  |
| Grafana   | Loki + AM         | `slack_configs`               | `email_configs`    |
| Cloudflare| Logpush + Workers | Custom consumer → webhook     | SendGrid / SES API |

Use **secrets** for webhook URLs and SMTP passwords; do not commit real URLs.
