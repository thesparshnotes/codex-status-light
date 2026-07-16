import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  computeProjection,
  defaultHistoryFile,
  pruneHistory,
  readSamples,
  recordSample,
} from "./usage-history.mjs";
import { computeStrategy, createStrategyPhraser } from "./strategy.mjs";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_CREDENTIALS_SERVICE = "Claude Code-credentials";
// The Claude Code Keychain item is keyed by the macOS login name.
const CLAUDE_CREDENTIALS_ACCOUNT = safeUsername();
const CLAUDE_TOKEN_EXPIRY_MARGIN_MS = 60_000;
const CLAUDE_REFRESH_COOLDOWN_MS = 15_000;
const HISTORY_PRUNE_INTERVAL_MS = 86_400_000;

const defaultClaudeRefreshState = createClaudeRefreshState();

export async function fetchCodexUsage({
  authFile = path.join(os.homedir(), ".codex", "auth.json"),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const auth = await readJsonFile(authFile);
  const token = auth?.tokens?.access_token;
  if (!token) throw new Error("Missing Codex access token");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": `codex-status-light/${await packageVersion()}`,
  };
  const [usageJson, creditsJson] = await Promise.all([
    fetchJson(CODEX_USAGE_URL, { headers, fetchImpl }),
    fetchJson(CODEX_CREDITS_URL, { headers, fetchImpl }),
  ]);
  return parseCodexUsage(usageJson, creditsJson);
}

export async function fetchClaudeUsage({
  credentialsCommand = ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
  credentialsFile = path.join(os.homedir(), ".claude", ".credentials.json"),
  fetchImpl = globalThis.fetch,
  keychainWrite,
  execFileImpl = execFile,
  now = Date.now,
  refreshState = defaultClaudeRefreshState,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const tokenOptions = {
    credentialsCommand,
    credentialsFile,
    fetchImpl,
    keychainWrite,
    execFileImpl,
    now,
    refreshState,
  };
  let token = await ensureFreshClaudeToken(tokenOptions);

  try {
    return parseClaudeUsage(await fetchJson(CLAUDE_USAGE_URL, {
      headers: claudeUsageHeaders(token),
      fetchImpl,
    }));
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error;
    token = await ensureFreshClaudeToken({ ...tokenOptions, forceRefresh: true });
    return parseClaudeUsage(await fetchJson(CLAUDE_USAGE_URL, {
      headers: claudeUsageHeaders(token),
      fetchImpl,
    }));
  }
}

export function createClaudeRefreshState() {
  return {
    inFlight: null,
    lastRefreshAttempt: 0,
    lastRefreshError: null,
    lastRefreshToken: null,
  };
}

export async function ensureFreshClaudeToken({
  credentialsCommand = ["security", "find-generic-password", "-s", CLAUDE_CREDENTIALS_SERVICE, "-w"],
  credentialsFile = path.join(os.homedir(), ".claude", ".credentials.json"),
  fetchImpl = globalThis.fetch,
  keychainWrite,
  execFileImpl = execFile,
  now = Date.now,
  refreshState = defaultClaudeRefreshState,
  forceRefresh = false,
} = {}) {
  const credentials = await readClaudeCredentials({ credentialsCommand, credentialsFile, execFileImpl });
  const oauth = credentials?.claudeAiOauth;
  const accessToken = oauth?.accessToken;
  if (!accessToken) throw new Error("Missing Claude access token");

  if (!forceRefresh && !isClaudeTokenExpired(oauth, now())) return accessToken;
  return refreshClaudeToken({
    credentials,
    oauth,
    fetchImpl,
    keychainWrite,
    execFileImpl,
    now,
    refreshState,
  });
}

export async function refreshClaudeToken({
  credentials,
  oauth,
  fetchImpl = globalThis.fetch,
  keychainWrite,
  execFileImpl = execFile,
  now = Date.now,
  refreshState = defaultClaudeRefreshState,
} = {}) {
  if (refreshState.inFlight) return refreshState.inFlight;

  const attemptAge = now() - refreshState.lastRefreshAttempt;
  if (refreshState.lastRefreshAttempt && attemptAge >= 0 && attemptAge < CLAUDE_REFRESH_COOLDOWN_MS) {
    if (refreshState.lastRefreshError) throw refreshState.lastRefreshError;
    if (refreshState.lastRefreshToken) return refreshState.lastRefreshToken;
  }

  refreshState.lastRefreshAttempt = now();
  refreshState.inFlight = doRefreshClaudeToken({
    credentials,
    oauth,
    fetchImpl,
    keychainWrite,
    execFileImpl,
    now,
  })
    .then((token) => {
      refreshState.lastRefreshError = null;
      refreshState.lastRefreshToken = token;
      return token;
    })
    .catch((error) => {
      refreshState.lastRefreshError = error;
      refreshState.lastRefreshToken = null;
      throw error;
    })
    .finally(() => {
      refreshState.inFlight = null;
    });

  return refreshState.inFlight;
}

export function parseCodexUsage(usageJson = {}, creditsJson = {}) {
  const rateLimit = objectAt(usageJson, "rate_limit");
  const windows = [
    codexWindowForDuration(rateLimit?.primary_window, "session", "5-hour usage"),
    codexWindowForDuration(rateLimit?.secondary_window, "weekly", "Weekly usage"),
  ]
    .filter(Boolean)
    .sort((left, right) => codexWindowOrder(left.key) - codexWindowOrder(right.key));

  const keyCounts = new Map();
  for (const window of windows) {
    const count = (keyCounts.get(window.key) ?? 0) + 1;
    keyCounts.set(window.key, count);
    if (count > 1) window.key = `${window.key}_${count}`;
  }

  const creditArray = Array.isArray(creditsJson?.credits) ? creditsJson.credits : null;
  const availableFromArray = creditArray
    ? creditArray.filter((credit) => credit?.status === "available").length
    : null;
  const available = availableFromArray ?? numberOrNull(creditsJson?.available_count)
    ?? numberOrNull(usageJson?.rate_limit_reset_credits?.available_count) ?? 0;
  const credits = creditArray ? creditArray.map(codexResetCredit).filter(Boolean) : [];

  return {
    ok: true,
    error: null,
    fetchedAt: new Date().toISOString(),
    plan: stringOrNull(usageJson?.plan_type),
    windows,
    resetCredits: { available, credits },
  };
}

export function parseClaudeUsage(json = {}) {
  const limits = Array.isArray(json?.limits) ? json.limits : [];
  const windows = limits.length > 0
    ? limits.map(claudeLimitWindow).filter(Boolean)
    : claudeFallbackWindows(json);

  return {
    ok: true,
    error: null,
    fetchedAt: new Date().toISOString(),
    windows,
    extraUsage: objectAt(json, "extra_usage") ?? {},
  };
}

export function startUsageCollector({
  intervalMs = 300_000,
  onUpdate,
  fetchImpl = globalThis.fetch,
  fetchCodex = (options) => fetchCodexUsage(options),
  fetchClaude = (options) => fetchClaudeUsage(options),
  codexOptions = {},
  claudeOptions = {},
  historyFile = defaultHistoryFile,
  startImmediately = true,
} = {}) {
  const collector = new UsageCollector({
    intervalMs,
    onUpdate,
    fetchImpl,
    fetchCodex,
    fetchClaude,
    codexOptions,
    claudeOptions,
    historyFile,
  });
  collector.start({ startImmediately });
  return {
    getSnapshot: () => collector.getSnapshot(),
    refresh: () => collector.refresh(),
    stop: () => collector.stop(),
  };
}

class UsageCollector {
  constructor({ intervalMs, onUpdate, fetchImpl, fetchCodex, fetchClaude, codexOptions, claudeOptions, historyFile }) {
    this.intervalMs = intervalMs;
    this.onUpdate = onUpdate;
    this.fetchImpl = fetchImpl;
    this.fetchCodex = fetchCodex;
    this.fetchClaude = fetchClaude;
    this.codexOptions = codexOptions;
    this.claudeOptions = claudeOptions;
    this.historyFile = historyFile;
    this.historyPrune = null;
    this.lastHistoryPruneMs = 0;
    this.timer = null;
    this.closed = false;
    this.snapshot = null;
    this.strategyPhraser = createStrategyPhraser({ fetchImpl });
    this.providers = {
      codex: null,
      claude: null,
    };
    this.backoffUntil = {
      codex: 0,
      claude: 0,
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
    await this.initHistory();
    await Promise.all([
      this.refreshProvider("codex", this.fetchCodex, this.codexOptions),
      this.refreshProvider("claude", this.fetchClaude, this.claudeOptions),
    ]);
    this.publish();
  }

  async refreshProvider(name, fetchProvider, options) {
    const now = Date.now();
    if (this.backoffUntil[name] && this.backoffUntil[name] > now) return;

    try {
      const provider = await fetchProvider({ ...options, fetchImpl: this.fetchImpl });
      const normalized = normalizeSuccessProvider(provider);
      await recordSample({
        historyFile: this.historyFile,
        provider: name,
        windows: normalized.windows,
        nowMs: now,
      });
      this.providers[name] = await this.withProjection(name, normalized);
      this.backoffUntil[name] = 0;
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) {
        const retryAt = retryAfterTime(error.retryAfter, Date.now());
        if (retryAt) this.backoffUntil[name] = retryAt;
      }
      this.providers[name] = errorProvider(this.providers[name], error);
    }
  }

  publish() {
    if (this.closed) return;
    const providers = {
      codex: this.providers.codex ?? errorProvider(null, new Error("No Codex usage snapshot yet")),
      claude: this.providers.claude ?? errorProvider(null, new Error("No Claude usage snapshot yet")),
    };
    const strategy = computeStrategy({
      codex: providers.codex,
      claude: providers.claude,
      nowMs: Date.now(),
    });
    this.snapshot = {
      updatedAt: new Date().toISOString(),
      providers,
      strategy,
    };
    this.onUpdate?.(this.snapshot);
    this.strategyPhraser.maybeRephrase(strategy, {
      currentFactsHash: () => this.snapshot?.strategy?.factsHash ?? null,
      apply: (phrased) => {
        if (this.closed || !this.snapshot?.strategy) return;
        this.snapshot = {
          ...this.snapshot,
          strategy: {
            ...this.snapshot.strategy,
            advice: phrased.advice,
            source: phrased.source,
          },
          updatedAt: new Date().toISOString(),
        };
        this.onUpdate?.(this.snapshot);
      },
    }).catch(() => {});
  }

  async initHistory() {
    const nowMs = Date.now();
    if (
      !this.historyPrune
      || nowMs - this.lastHistoryPruneMs >= HISTORY_PRUNE_INTERVAL_MS
      || nowMs < this.lastHistoryPruneMs
    ) {
      this.lastHistoryPruneMs = nowMs;
      this.historyPrune = pruneHistory({
        historyFile: this.historyFile,
        nowMs,
      }).catch(() => {});
    }
    await this.historyPrune;
  }

  async withProjection(name, provider) {
    const samples = await readSamples({ historyFile: this.historyFile }).catch(() => []);
    const nowMs = Date.now();
    let primaryProjection = null;
    const projectedWindows = provider.windows.map((window) => {
      if (!isWeeklyFamilyWindow(window)) return window;
      const projection = computeProjection({
        windows: provider.windows,
        samples,
        provider: name,
        nowMs,
        windowKey: window.key,
      });
      if (window.key === "weekly" && primaryProjection === null) primaryProjection = projection;
      return { ...window, projection };
    });
    const resetCredits = normalizeResetCredits(provider.resetCredits);

    return {
      ...provider,
      windows: projectedWindows,
      projection: primaryProjection,
      resetCredits: {
        ...resetCredits,
        advice: null,
        adviceKind: null,
      },
    };
  }
}

function normalizeSuccessProvider(provider) {
  return {
    ...provider,
    ok: true,
    error: null,
    fetchedAt: validIsoOrNow(provider?.fetchedAt),
    windows: Array.isArray(provider?.windows) ? provider.windows : [],
    projection: provider?.projection ?? null,
    resetCredits: normalizeResetCredits(provider?.resetCredits),
  };
}

function errorProvider(previous, error) {
  return {
    ...(previous ?? {}),
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    fetchedAt: previous?.fetchedAt ?? null,
    windows: Array.isArray(previous?.windows) ? previous.windows : [],
    projection: previous?.projection ?? null,
    resetCredits: normalizeResetCredits(previous?.resetCredits),
  };
}

function normalizeResetCredits(resetCredits) {
  const credits = Array.isArray(resetCredits?.credits) ? resetCredits.credits : [];
  return {
    available: numberOrNull(resetCredits?.available) ?? 0,
    credits,
    advice: null,
    adviceKind: null,
  };
}

function isWeeklyFamilyWindow(window) {
  return window?.key === "weekly" || (typeof window?.key === "string" && window.key.startsWith("weekly_scoped:"));
}

async function fetchJson(url, { headers, fetchImpl }) {
  const response = await fetchImpl(url, { headers });
  if (!response?.ok) {
    throw new HttpError(`HTTP ${response?.status ?? "error"} fetching ${url}`, {
      status: response?.status,
      retryAfter: response?.headers?.get?.("retry-after") ?? response?.headers?.get?.("Retry-After"),
    });
  }
  return response.json();
}

function claudeUsageHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
    "User-Agent": "claude-code/2.1.0",
  };
}

class HttpError extends Error {
  constructor(message, { status, retryAfter } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function readClaudeCredentials({ credentialsCommand, credentialsFile, execFileImpl }) {
  try {
    const [command, ...args] = credentialsCommand;
    const { stdout } = await execFileWithImpl(execFileImpl, command, args, { timeout: 5000 });
    const credentials = JSON.parse(stdout);
    if (tokenFromClaudeCredentials(credentials)) return credentials;
  } catch {
    // Fall through to the file-backed credentials used on non-Keychain systems.
  }

  return readJsonFile(credentialsFile);
}

function tokenFromClaudeCredentials(credentials) {
  return credentials?.claudeAiOauth?.accessToken ?? null;
}

function isClaudeTokenExpired(oauth, nowMs) {
  const expiresAt = numberOrNull(oauth?.expiresAt);
  if (expiresAt === null) return false;
  return expiresAt <= nowMs + CLAUDE_TOKEN_EXPIRY_MARGIN_MS;
}

async function doRefreshClaudeToken({
  credentials,
  oauth,
  fetchImpl,
  keychainWrite,
  execFileImpl,
  now,
}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const oldRefreshToken = oauth?.refreshToken;
  if (!oldRefreshToken) throw new Error("Missing Claude refresh token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: oldRefreshToken,
    client_id: CLAUDE_CLIENT_ID,
  });

  const response = await fetchImpl(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const json = await safeResponseJson(response);
  if (!response?.ok) {
    if (json?.error === "invalid_grant") {
      throw new Error("Claude token refresh failed: invalid_grant — run: claude (to re-login)");
    }
    throw new Error(`Claude token refresh failed: HTTP ${response?.status ?? "error"}`);
  }

  const accessToken = stringOrNull(json?.access_token);
  const expiresIn = numberOrNull(json?.expires_in);
  if (!accessToken || expiresIn === null) {
    throw new Error("Claude token refresh failed: invalid response");
  }

  const updatedCredentials = stableClaudeCredentialsJson({
    credentials,
    accessToken,
    refreshToken: stringOrNull(json?.refresh_token) ?? oldRefreshToken,
    expiresAt: now() + expiresIn * 1000,
  });
  await writeClaudeCredentials(updatedCredentials, { keychainWrite, execFileImpl });
  return accessToken;
}

function stableClaudeCredentialsJson({ credentials, accessToken, refreshToken, expiresAt }) {
  const previous = credentials?.claudeAiOauth ?? {};
  return {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes: Array.isArray(previous.scopes) ? previous.scopes : [],
      subscriptionType: previous.subscriptionType,
      rateLimitTier: previous.rateLimitTier,
    },
  };
}

async function writeClaudeCredentials(credentials, { keychainWrite, execFileImpl }) {
  const credentialsJson = JSON.stringify(credentials);
  if (keychainWrite) {
    await keychainWrite({ credentials, credentialsJson, execFileImpl });
    return;
  }
  await defaultClaudeKeychainWrite({ credentialsJson, execFileImpl });
}

async function defaultClaudeKeychainWrite({ credentialsJson, execFileImpl }) {
  await execFileWithImpl(execFileImpl, "security", [
    "add-generic-password",
    "-U",
    "-a",
    CLAUDE_CREDENTIALS_ACCOUNT,
    "-s",
    CLAUDE_CREDENTIALS_SERVICE,
    "-w",
    credentialsJson,
  ], { timeout: 5000 });
}

function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || "";
  }
}

async function safeResponseJson(response) {
  try {
    return typeof response?.json === "function" ? await response.json() : null;
  } catch {
    return null;
  }
}

async function execFileWithImpl(execFileImpl, command, args, options) {
  if (execFileImpl === execFile) return execFileAsync(command, args, options);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    try {
      const result = execFileImpl(command, args, options, finish);
      if (result && typeof result.then === "function") {
        result.then(
          (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          },
        );
      }
    } catch (error) {
      finish(error);
    }
  });
}

async function readJsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

let cachedPackageVersion = null;
async function packageVersion() {
  if (!cachedPackageVersion) {
    const pkg = await readJsonFile(path.join(rootDir, "package.json"));
    cachedPackageVersion = String(pkg.version || "0.0.0");
  }
  return cachedPackageVersion;
}

function codexWindow(key, label, raw) {
  const usedPercent = numberOrNull(raw?.used_percent);
  if (usedPercent === null && raw?.reset_at === undefined) return null;
  return {
    key,
    label,
    usedPercent: usedPercent ?? 0,
    resetsAt: epochSecondsToIso(raw?.reset_at),
  };
}

function codexWindowForDuration(raw, fallbackKey, fallbackLabel) {
  if (raw == null) return null;
  const duration = numberOrNull(raw.limit_window_seconds);
  if (duration === null || duration <= 0) return codexWindow(fallbackKey, fallbackLabel, raw);
  if (duration <= 21_600) return codexWindow("session", "5-hour usage", raw);
  if (duration >= 172_800) return codexWindow("weekly", "Weekly usage", raw);
  return codexWindow(
    `window_${duration}`,
    `${Math.round(duration / 3600)}-hour usage`,
    raw,
  );
}

function codexWindowOrder(key) {
  if (key === "session") return 0;
  if (key === "weekly") return 1;
  return 2;
}

function codexResetCredit(raw) {
  const title = stringOrNull(raw?.title);
  const status = stringOrNull(raw?.status);
  const grantedAt = stringOrNull(raw?.granted_at);
  const expiresAt = stringOrNull(raw?.expires_at);
  if (!title || !status || !grantedAt || !expiresAt) return null;
  return { title, status, grantedAt, expiresAt };
}

function claudeLimitWindow(limit) {
  const usedPercent = numberOrNull(limit?.percent);
  if (usedPercent === null) return null;
  const kind = stringOrNull(limit?.kind) ?? "unknown";
  const group = stringOrNull(limit?.group);
  const displayName = stringOrNull(limit?.scope?.model?.display_name);
  const scopedWeekly = kind === "weekly_scoped" && displayName;
  const weeklyAll = kind === "weekly_all" || (group === "weekly" && !displayName);
  const key = kind === "session"
    ? "session"
    : weeklyAll
      ? "weekly"
      : scopedWeekly
        ? `weekly_scoped:${displayName}`
        : kind;
  const label = kind === "session"
    ? "Session (5h)"
    : weeklyAll
      ? "Weekly (all models)"
      : scopedWeekly
        ? `Weekly (${displayName})`
        : humanize(kind);

  return {
    key,
    label,
    usedPercent,
    resetsAt: isoOrNull(limit?.resets_at),
  };
}

function claudeFallbackWindows(json) {
  return [
    claudeFallbackWindow("session", "Session (5h)", json?.five_hour),
    claudeFallbackWindow("weekly", "Weekly (all models)", json?.seven_day),
  ].filter(Boolean);
}

function claudeFallbackWindow(key, label, raw) {
  const usedPercent = numberOrNull(raw?.utilization);
  if (usedPercent === null && raw?.resets_at === undefined) return null;
  return {
    key,
    label,
    usedPercent: usedPercent ?? 0,
    resetsAt: isoOrNull(raw?.resets_at),
  };
}

function objectAt(value, key) {
  const next = value?.[key];
  return next && typeof next === "object" && !Array.isArray(next) ? next : null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}

function epochSecondsToIso(value) {
  const seconds = numberOrNull(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function validIsoOrNow(value) {
  return isoOrNull(value) ?? new Date().toISOString();
}

function humanize(value) {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function retryAfterTime(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}
