const API_BASE = import.meta.env?.VITE_API_BASE_URL || "https://api.memorynode.ai";

async function checkHealth() {
  const badge = document.getElementById("api-status");
  const detail = document.getElementById("api-status-detail");

  try {
    const res = await fetch(`${API_BASE}/healthz`, { method: "GET" });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data?.status === "ok") {
      badge.textContent = "Operational";
      badge.className = "status-badge status-operational";
      detail.textContent = `API responding (v${data.version ?? "—"})`;
    } else {
      badge.textContent = "Degraded";
      badge.className = "status-badge status-degraded";
      detail.textContent = `Health check returned ${res.status}`;
    }
  } catch (err) {
    badge.textContent = "Outage";
    badge.className = "status-badge status-outage";
    detail.textContent = err.message || "Unable to reach API";
  }
}

async function loadIncidents() {
  const list = document.getElementById("incident-list");
  try {
    const res = await fetch("/incidents.json");
    const incidents = await res.json();

    if (!incidents?.length) {
      list.innerHTML = '<p class="no-incidents">No incidents recorded.</p>';
      return;
    }

    list.innerHTML = incidents
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(
        (i) => `
        <div class="incident">
          <span class="incident-date">${i.date}</span>
          <span class="incident-severity">${i.severity || ""}</span>
          <div class="incident-title">${escapeHtml(i.title)}</div>
          ${i.description ? `<div class="incident-desc">${escapeHtml(i.description)}</div>` : ""}
        </div>
      `
      )
      .join("");
  } catch {
    list.innerHTML = '<p class="no-incidents">Incident history unavailable.</p>';
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function setLastUpdated() {
  document.getElementById("last-updated").textContent = new Date().toISOString();
}

checkHealth();
loadIncidents();
setLastUpdated();
