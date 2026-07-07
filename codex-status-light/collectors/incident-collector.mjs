const PROVIDERS = {
  codex: {
    statusUrl: "https://status.openai.com",
    statusJsonUrl: "https://status.openai.com/api/v2/status.json",
    incidentsJsonUrl: "https://status.openai.com/api/v2/incidents/unresolved.json",
  },
  claude: {
    statusUrl: "https://status.claude.com",
    statusJsonUrl: "https://status.claude.com/api/v2/status.json",
    incidentsJsonUrl: "https://status.claude.com/api/v2/incidents/unresolved.json",
  },
};

const VALID_INDICATORS = new Set(["none", "minor", "major", "critical"]);

export function parseIncidents(statusJson, incidentsJson, { statusUrl } = {}) {
  try {
    const rawIndicator = stringOrNull(statusJson?.status?.indicator);
    const indicator = VALID_INDICATORS.has(rawIndicator) ? rawIndicator : "none";
    const incidents = Array.isArray(incidentsJson?.incidents)
      ? incidentsJson.incidents.map(parseIncident).filter(Boolean)
      : [];

    return {
      ok: true,
      error: null,
      indicator,
      description: stringOrNull(statusJson?.status?.description) ?? "",
      statusUrl: stringOrNull(statusUrl) ?? "",
      incidents,
    };
  } catch {
    return emptyParsedIncidents({ statusUrl });
  }
}

export function startIncidentCollector({
  intervalMs = 300_000,
  onUpdate,
  fetchImpl = globalThis.fetch,
  startImmediately = true,
} = {}) {
  const collector = new IncidentCollector({
    intervalMs,
    onUpdate,
    fetchImpl,
  });
  collector.start({ startImmediately });
  return {
    getSnapshot: () => collector.getSnapshot(),
    refresh: () => collector.refresh(),
    stop: () => collector.stop(),
  };
}

class IncidentCollector {
  constructor({ intervalMs, onUpdate, fetchImpl }) {
    this.intervalMs = intervalMs;
    this.onUpdate = onUpdate;
    this.fetchImpl = fetchImpl;
    this.timer = null;
    this.closed = false;
    this.snapshot = null;
    this.providers = {
      codex: null,
      claude: null,
    };
  }

  start({ startImmediately }) {
    if (startImmediately) this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.intervalMs);
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer);
  }

  getSnapshot() {
    return this.snapshot;
  }

  async refresh() {
    if (this.closed) return;
    await Promise.all([
      this.refreshProvider("codex", PROVIDERS.codex),
      this.refreshProvider("claude", PROVIDERS.claude),
    ]);
    this.publish();
  }

  async refreshProvider(name, provider) {
    try {
      // status.json is required, but not every status page implements the
      // incidents endpoint (status.openai.com 404s it) — degrade to
      // status-only rather than failing the whole provider, keeping the
      // last-good incidents list.
      const [statusJson, incidentsJson] = await Promise.all([
        fetchJson(provider.statusJsonUrl, { fetchImpl: this.fetchImpl }),
        fetchJson(provider.incidentsJsonUrl, { fetchImpl: this.fetchImpl }).catch(() => null),
      ]);
      const parsed = parseIncidents(statusJson, incidentsJson, { statusUrl: provider.statusUrl });
      if (incidentsJson === null) {
        parsed.incidents = Array.isArray(this.providers[name]?.incidents)
          ? this.providers[name].incidents
          : [];
      }
      this.providers[name] = normalizeSuccessProvider(parsed);
    } catch (error) {
      this.providers[name] = errorProvider(
        this.providers[name],
        error,
        { statusUrl: provider.statusUrl },
      );
    }
  }

  publish() {
    if (this.closed) return;
    this.snapshot = {
      updatedAt: new Date().toISOString(),
      providers: {
        codex: this.providers.codex ?? errorProvider(null, new Error("No Codex incident snapshot yet"), {
          statusUrl: PROVIDERS.codex.statusUrl,
        }),
        claude: this.providers.claude ?? errorProvider(null, new Error("No Claude incident snapshot yet"), {
          statusUrl: PROVIDERS.claude.statusUrl,
        }),
      },
    };
    this.onUpdate?.(this.snapshot);
  }
}

function normalizeSuccessProvider(provider) {
  return {
    ...emptyParsedIncidents({ statusUrl: provider?.statusUrl }),
    ...provider,
    ok: true,
    error: null,
    fetchedAt: new Date().toISOString(),
    incidents: Array.isArray(provider?.incidents) ? provider.incidents : [],
  };
}

function errorProvider(previous, error, { statusUrl } = {}) {
  return {
    ...emptyParsedIncidents({ statusUrl }),
    ...(previous ?? {}),
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    fetchedAt: previous?.fetchedAt ?? null,
    incidents: Array.isArray(previous?.incidents) ? previous.incidents : [],
  };
}

function emptyParsedIncidents({ statusUrl } = {}) {
  return {
    ok: true,
    error: null,
    indicator: "none",
    description: "",
    statusUrl: stringOrNull(statusUrl) ?? "",
    incidents: [],
  };
}

async function fetchJson(url, { fetchImpl }) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "codex-status-light",
    },
    redirect: "follow",
  });
  if (!response?.ok) {
    throw new Error(`HTTP ${response?.status ?? "error"} fetching ${url}`);
  }
  return response.json();
}

function parseIncident(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    name: stringOrNull(raw.name) ?? "Untitled incident",
    impact: stringOrNull(raw.impact) ?? "none",
    url: stringOrNull(raw.shortlink),
    startedAt: stringOrNull(raw.started_at) ?? stringOrNull(raw.created_at),
  };
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}
