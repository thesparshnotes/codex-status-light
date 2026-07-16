import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const HISTORY_RETENTION_MS = 30 * DAY_MS;
const HISTORY_MAX_LINES = 20_000;
const SAMPLE_MIN_GAP_MS = 4 * 60_000;
const EPOCH_TOLERANCE_MS = 15 * 60_000;

export const defaultHistoryFile = process.env.CODEX_LIGHT_HISTORY_FILE
  || path.join(os.homedir(), ".codex-light", "usage-history.jsonl");

export async function recordSample({
  historyFile = defaultHistoryFile,
  provider,
  windows,
  nowMs = Date.now(),
  appendImpl,
  readTailImpl,
} = {}) {
  if (!validProvider(provider) || !Array.isArray(windows) || !finiteNumber(nowMs)) {
    return { recorded: false };
  }

  const lastSample = await readLastProviderSample({ historyFile, provider, readTailImpl });
  if (lastSample !== null && nowMs - lastSample >= 0 && nowMs - lastSample < SAMPLE_MIN_GAP_MS) {
    return { recorded: false, lastSampleAt: new Date(lastSample).toISOString() };
  }

  const sample = {
    t: new Date(nowMs).toISOString(),
    provider,
    windows: windows.map((window) => ({
      key: window?.key,
      usedPercent: window?.usedPercent,
      resetsAt: window?.resetsAt,
    })),
  };
  const append = appendImpl ?? defaultAppend;
  await append(historyFile, `${JSON.stringify(sample)}\n`);
  return { recorded: true, lastSampleAt: sample.t };
}

export async function readSamples({ historyFile = defaultHistoryFile, readImpl } = {}) {
  let text;
  try {
    text = await (readImpl ?? readFile)(historyFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return parseHistoryLines(text);
}

export async function pruneHistory({
  historyFile = defaultHistoryFile,
  nowMs = Date.now(),
  readImpl,
  writeImpl,
  renameImpl,
  mkdirImpl,
} = {}) {
  let text;
  try {
    text = await (readImpl ?? readFile)(historyFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { kept: 0, dropped: 0 };
    throw error;
  }

  const cutoff = nowMs - HISTORY_RETENTION_MS;
  const parsed = parseHistoryLines(text);
  const kept = parsed
    .filter((sample) => sample.tMs >= cutoff && sample.tMs <= nowMs)
    .slice(-HISTORY_MAX_LINES);
  const tmpFile = `${historyFile}.tmp`;
  const body = kept.map(historyLine).join("");
  await (mkdirImpl ?? mkdir)(path.dirname(historyFile), { recursive: true });
  await (writeImpl ?? writeFile)(tmpFile, body, "utf8");
  await (renameImpl ?? rename)(tmpFile, historyFile);
  return { kept: kept.length, dropped: Math.max(0, text.split(/\r?\n/).filter(Boolean).length - kept.length) };
}

export function computeProjection({ windows, samples = [], provider, nowMs = Date.now(), windowKey = "weekly" } = {}) {
  const targetWindow = Array.isArray(windows)
    ? windows.find((window) => window?.key === windowKey)
    : null;
  const current = validWindow(targetWindow);
  if (!current || !validProvider(provider) || !finiteNumber(nowMs)) return null;

  const resetMs = Date.parse(current.resetsAt);
  // A resetsAt in the past means the window data is stale (already reset);
  // projecting an expired window would report a misleading "safe".
  if (nowMs >= resetMs) return null;
  const windowStart = resetMs - WEEK_MS;
  const elapsedH = (nowMs - windowStart) / 3_600_000;
  const weekPace = elapsedH >= 6
    ? paceObject(Math.max(0, current.usedPercent) / elapsedH, current.usedPercent, resetMs, nowMs)
    : null;
  const recentPace = recentPaceObject({
    provider,
    samples,
    current,
    resetMs,
    nowMs,
    windowKey,
  });
  const activeDay = activeDayObject({
    provider,
    samples,
    current,
    nowMs,
    windowKey,
  });

  const available = [weekPace, recentPace].filter(Boolean);
  const caps = available.filter((pace) => pace.capsBeforeReset).length;
  const status = available.length === 0
    ? "collecting"
    : caps === 0
      ? "safe"
      : caps === available.length
        ? "critical"
        : "warning";

  return {
    windowKey,
    status,
    weekPace,
    recentPace,
    activeDay,
    summary: summaryFor({ weekPace, recentPace, activeDay, status }),
  };
}

async function defaultAppend(file, line) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, line, "utf8");
}

async function readLastProviderSample({ historyFile, provider, readTailImpl }) {
  if (readTailImpl) {
    const value = await readTailImpl({ historyFile, provider });
    const parsed = typeof value === "number" ? value : Date.parse(value?.t ?? value);
    return finiteNumber(parsed) ? parsed : null;
  }

  const samples = await readSamples({ historyFile });
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].provider === provider) return samples[index].tMs;
  }
  return null;
}

function recentPaceObject({ provider, samples, current, resetMs, nowMs, windowKey }) {
  const matching = validMatchingSamples({ provider, samples, resetMs, nowMs, windowKey });
  if (matching.length === 0) return null;

  const targetMs = nowMs - DAY_MS;
  let baseline = null;
  for (const sample of matching) {
    if (sample.tMs <= targetMs && (!baseline || sample.tMs >= baseline.tMs)) {
      baseline = sample;
    }
  }
  if (!baseline) {
    // Earliest same-epoch sample; among duplicate timestamps the LAST in
    // file order wins (amendment 6).
    baseline = matching[0];
    for (const sample of matching) {
      if (sample.tMs <= baseline.tMs) baseline = sample;
    }
  }

  const spanH = (nowMs - baseline.tMs) / 3_600_000;
  if (!finiteNumber(spanH) || spanH < 4) return null;
  const paceHourly = Math.max(0, current.usedPercent - baseline.usedPercent) / spanH;
  return paceObject(paceHourly, current.usedPercent, resetMs, nowMs);
}

function validMatchingSamples({ provider, samples, resetMs, nowMs, windowKey }) {
  const result = [];
  for (const sample of Array.isArray(samples) ? samples : []) {
    const tMs = finiteNumber(sample?.tMs) ? sample.tMs : Date.parse(sample?.t);
    if (!finiteNumber(tMs) || tMs > nowMs || sample?.provider !== provider) continue;
    const matchingWindow = Array.isArray(sample.windows)
      ? sample.windows.find((window) => window?.key === windowKey)
      : null;
    const window = validWindow(matchingWindow);
    if (!window) continue;
    const sampleResetMs = Date.parse(window.resetsAt);
    if (Math.abs(sampleResetMs - resetMs) > EPOCH_TOLERANCE_MS) continue;
    result.push({ tMs, usedPercent: window.usedPercent });
  }
  return result.sort((left, right) => left.tMs - right.tMs);
}

function activeDayObject({ provider, samples, current, nowMs, windowKey }) {
  const rows = validProviderWindowSamples({ provider, samples, nowMs, windowKey });
  if (rows.length === 0) return null;

  const resetClusters = clusteredResetInstants(rows.map((row) => row.resetMs));
  const days = trailingLocalDays(nowMs, 14);
  const burns = [];
  for (const day of days) {
    if (resetClusters.some((resetMs) => resetMs >= day.startMs && resetMs < day.endMs)) continue;
    const dayRows = rows
      .filter((row) => row.tMs >= day.startMs && row.tMs < day.endMs)
      .sort((left, right) => left.tMs - right.tMs || left.index - right.index);
    if (dayRows.length < 2) continue;

    const byTimestamp = [];
    for (const row of dayRows) {
      if (byTimestamp.length > 0 && byTimestamp[byTimestamp.length - 1].tMs === row.tMs) {
        byTimestamp[byTimestamp.length - 1] = row;
      } else {
        byTimestamp.push(row);
      }
    }
    if (byTimestamp.length < 2) continue;
    const dayBurn = Math.max(0, byTimestamp[byTimestamp.length - 1].usedPercent - byTimestamp[0].usedPercent);
    if (dayBurn >= 3) burns.push(dayBurn);
  }

  if (burns.length < 2) return null;
  const median = medianOf(burns);
  const percentPerDay = Math.round(median * 10) / 10;
  return {
    percentPerDay,
    heavyDaysLeft: Math.round(((100 - current.usedPercent) / median) * 10) / 10,
    activeDays: burns.length,
  };
}

function validProviderWindowSamples({ provider, samples, nowMs, windowKey }) {
  const result = [];
  let index = 0;
  for (const sample of Array.isArray(samples) ? samples : []) {
    const tMs = finiteNumber(sample?.tMs) ? sample.tMs : Date.parse(sample?.t);
    const matchingWindow = Array.isArray(sample?.windows)
      ? sample.windows.find((window) => window?.key === windowKey)
      : null;
    const window = validWindow(matchingWindow);
    const resetMs = Date.parse(window?.resetsAt);
    if (
      finiteNumber(tMs)
      && tMs <= nowMs
      && sample?.provider === provider
      && window
      && finiteNumber(resetMs)
    ) {
      result.push({ index, tMs, usedPercent: window.usedPercent, resetMs });
    }
    index += 1;
  }
  return result;
}

function clusteredResetInstants(resetValues) {
  const sorted = [...new Set(resetValues.filter(finiteNumber))].sort((left, right) => left - right);
  const clusters = [];
  for (const resetMs of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && resetMs - last[last.length - 1] <= EPOCH_TOLERANCE_MS) {
      last.push(resetMs);
    } else {
      clusters.push([resetMs]);
    }
  }
  return clusters.map((cluster) => cluster[0]);
}

function trailingLocalDays(nowMs, count) {
  const now = new Date(nowMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Array.from({ length: count }, (_, offset) => {
    const startMs = new Date(todayStart).setDate(new Date(todayStart).getDate() - (count - 1 - offset));
    const endMs = new Date(startMs).setDate(new Date(startMs).getDate() + 1);
    return { startMs, endMs };
  });
}

function medianOf(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function paceObject(paceHourly, usedPercent, resetMs, nowMs) {
  const runsOutMs = paceHourly > 0.01
    ? nowMs + ((100 - usedPercent) / paceHourly) * 3_600_000
    : null;
  const runsOutAt = finiteNumber(runsOutMs) ? new Date(runsOutMs).toISOString() : null;
  return {
    percentPerDay: Math.round(paceHourly * 24 * 10) / 10,
    runsOutAt,
    capsBeforeReset: runsOutMs !== null && runsOutMs < resetMs,
  };
}

function summaryFor({ weekPace, recentPace, activeDay, status }) {
  if (status === "collecting") return "Collecting usage baseline…";
  const segments = recentPace
    ? [
        paceSummary("Last 24h", recentPace),
        weekPace ? paceSummary("Week avg", weekPace) : null,
      ]
    : [
        weekPace ? paceSummary("Week avg", weekPace) : null,
      ];
  if (activeDay) {
    segments.push(`≈${activeDay.heavyDaysLeft.toFixed(1)} heavy days of budget left`);
  } else if (!recentPace) {
    segments.push("collecting burst data");
  }
  return segments.filter(Boolean).join(" · ");
}

function paceSummary(label, pace) {
  return `${label} ${pace.percentPerDay.toFixed(1)}%/day ${pace.runsOutAt && pace.capsBeforeReset
    ? `— runs out ${shortDateTime(Date.parse(pace.runsOutAt))}`
    : "— safe until reset"}`;
}

function parseHistoryLines(text) {
  const samples = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      const tMs = Date.parse(raw?.t);
      if (!finiteNumber(tMs) || !validProvider(raw?.provider) || !Array.isArray(raw?.windows)) continue;
      const windows = raw.windows.map(validWindow).filter(Boolean);
      if (windows.length === 0) continue;
      samples.push({
        t: new Date(tMs).toISOString(),
        tMs,
        provider: raw.provider,
        windows,
      });
    } catch {
      // Corrupt JSONL records are intentionally ignored.
    }
  }
  return samples;
}

function validWindow(raw) {
  const key = typeof raw?.key === "string" ? raw.key : null;
  const usedPercent = Number(raw?.usedPercent);
  const resetMs = Date.parse(raw?.resetsAt);
  if (!key || !finiteNumber(usedPercent) || usedPercent < 0 || usedPercent > 100 || !finiteNumber(resetMs)) {
    return null;
  }
  return {
    key,
    usedPercent,
    resetsAt: new Date(resetMs).toISOString(),
  };
}

function historyLine(sample) {
  return `${JSON.stringify({
    t: sample.t,
    provider: sample.provider,
    windows: sample.windows,
  })}\n`;
}

function shortDateTime(ms) {
  return new Date(ms).toLocaleString("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function weekday(ms) {
  return new Date(ms).toLocaleString("en-US", { weekday: "short" });
}

function monthDay(ms) {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric" });
}

function finiteNumber(value) {
  return Number.isFinite(value);
}

function validProvider(provider) {
  return provider === "codex" || provider === "claude";
}
