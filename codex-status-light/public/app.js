const sessionsEl = document.querySelector("#sessions");
const overallLabelEl = document.querySelector("#overallLabel");
const overallMetaEl = document.querySelector("#overallMeta");
const updatedAtEl = document.querySelector("#updatedAt");
const lamps = new Map(
  [...document.querySelectorAll("[data-lamp]")].map((lamp) => [lamp.dataset.lamp, lamp])
);

const labels = {
  idle: "Idle",
  running: "Running",
  waiting: "Needs attention",
  done: "Done",
  error: "Error",
  stale: "Stale",
};

connect();

async function connect() {
  try {
    render(await fetchStatus());
    const events = new EventSource("/api/events");
    events.onmessage = (event) => render(JSON.parse(event.data));
    events.onerror = () => {
      overallMetaEl.textContent = "Reconnecting to the local status server.";
    };
  } catch {
    overallMetaEl.textContent = "The local status server is not responding.";
  }
}

async function fetchStatus() {
  const response = await fetch("/api/status");
  if (!response.ok) throw new Error("Unable to fetch status.");
  return response.json();
}

function render(state) {
  const summary = state.summary;
  const overall = summary.status === "done" ? "done" : summary.status;
  lamps.forEach((lamp, status) => {
    lamp.classList.toggle("active", status === mapLamp(overall));
  });

  overallLabelEl.textContent = labels[summary.status] ?? "Idle";
  overallMetaEl.textContent = metaFor(summary);
  updatedAtEl.textContent = state.updatedAt
    ? `Updated ${new Date(state.updatedAt).toLocaleString()}`
    : "No updates yet";

  if (!state.sessions.length) {
    sessionsEl.innerHTML = `<div class="empty">No Codex sessions are reporting yet.</div>`;
    return;
  }

  sessionsEl.innerHTML = state.sessions.map(renderSession).join("");
}

function renderSession(session) {
  const statusClass = escapeHtml(session.status);
  return `
    <article class="session">
      <div class="session-header">
        <h3>${escapeHtml(session.title)}</h3>
        <span class="badge"><i class="dot ${statusClass}"></i>${escapeHtml(labels[session.status] ?? session.status)}</span>
      </div>
      <div class="session-meta">
        <span>${escapeHtml(session.id)}</span>
        <span>${escapeHtml(relativeTime(session.updatedAt))}</span>
      </div>
    </article>
  `;
}

function metaFor(summary) {
  if (summary.total === 0) return "Waiting for session updates.";
  const parts = [];
  if (summary.counts.waiting) parts.push(`${summary.counts.waiting} waiting`);
  if (summary.counts.running) parts.push(`${summary.counts.running} running`);
  if (summary.counts.done) parts.push(`${summary.counts.done} done`);
  if (summary.counts.error) parts.push(`${summary.counts.error} error`);
  if (summary.counts.stale) parts.push(`${summary.counts.stale} stale`);
  if (summary.counts.idle) parts.push(`${summary.counts.idle} idle`);
  return parts.join(" · ");
}

function mapLamp(status) {
  if (status === "waiting" || status === "error") return "waiting";
  if (status === "running") return "running";
  return "done";
}

function relativeTime(value) {
  const date = new Date(value);
  const seconds = Math.max(1, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
