import { watch } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { updateSession } from "../store.mjs";

const DEFAULT_SCAN_INTERVAL_MS = 3000;
const DEFAULT_WAITING_HEURISTIC_SECONDS = 20;

export function parseRolloutLines(lines, options = {}) {
  let session = null;
  const now = options.now || new Date();
  const filePath = options.filePath || "";

  for (const line of lines) {
    const record = parseRecord(line);
    if (!record) continue;
    session = applyRecord(session, record, filePath);
  }

  if (!session) return null;

  const waitingHeuristicSeconds = Number(
    options.waitingHeuristicSeconds ?? process.env.CODEX_LIGHT_WAITING_HEURISTIC_SECONDS ?? DEFAULT_WAITING_HEURISTIC_SECONDS
  );
  const updatedAt = Date.parse(session.updatedAt);
  const ageSeconds = Number.isFinite(updatedAt) ? (now.getTime() - updatedAt) / 1000 : 0;
  if (session.status === "running" && ageSeconds > waitingHeuristicSeconds) {
    return {
      ...session,
      status: "waiting",
      title: session.title.startsWith("Possibly waiting: ")
        ? session.title
        : `Possibly waiting: ${session.title}`,
      confidence: "heuristic-file-quiet",
    };
  }

  return session;
}

export async function parseRolloutFile(filePath, options = {}) {
  const raw = await readFile(filePath, "utf8");
  return parseRolloutLines(raw.split(/\r?\n/).filter(Boolean), { ...options, filePath });
}

export async function scanRollouts({ dataFile, sessionsRoot = defaultSessionsRoot(), now = new Date() }) {
  const files = await listRecentRolloutFiles(sessionsRoot, now);
  const sessions = [];
  for (const file of files) {
    try {
      const session = await parseRolloutFile(file, { now });
      if (!session) continue;
      await updateSession(dataFile, session);
      sessions.push(session);
    } catch {
      // Rollout files are undocumented and may be partially written while read.
    }
  }
  return sessions;
}

export async function startRolloutWatcher(options) {
  const sessionsRoot = options.sessionsRoot || defaultSessionsRoot();
  const scanIntervalMs = options.scanIntervalMs || DEFAULT_SCAN_INTERVAL_MS;
  let closed = false;
  let watcher = null;

  const scan = () => {
    if (!closed) scanRollouts({ ...options, sessionsRoot }).catch(() => {});
  };

  await mkdir(dayDirectory(sessionsRoot, new Date()), { recursive: true });
  scan();

  try {
    watcher = watch(dayDirectory(sessionsRoot, new Date()), { persistent: true }, scan);
  } catch {
    watcher = null;
  }

  const interval = setInterval(scan, scanIntervalMs);
  return () => {
    closed = true;
    clearInterval(interval);
    watcher?.close();
  };
}

export function defaultSessionsRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

async function listRecentRolloutFiles(sessionsRoot, now) {
  const dirs = [
    dayDirectory(sessionsRoot, now),
    dayDirectory(sessionsRoot, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
  ];
  const files = [];
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
        const file = path.join(dir, entry);
        const info = await stat(file);
        files.push({ file, mtimeMs: info.mtimeMs });
      }
    } catch {
      // Missing date directories are normal.
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 20)
    .sort((a, b) => {
      const byNameTime = rolloutTimeFromPath(a.file) - rolloutTimeFromPath(b.file);
      return byNameTime || a.file.localeCompare(b.file);
    })
    .map((entry) => entry.file);
}

function rolloutTimeFromPath(filePath) {
  const match = path.basename(filePath).match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  if (!match) return 0;
  const isoish = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3.000Z");
  const time = Date.parse(isoish);
  return Number.isFinite(time) ? time : 0;
}

function dayDirectory(root, date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return path.join(root, year, month, day);
}

function parseRecord(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function applyRecord(current, record, filePath) {
  const payloadType = record.payload?.type;
  const recordKey = [record.type, payloadType].filter(Boolean).join(".");
  const timestamp = record.timestamp || record.payload?.started_at || record.payload?.completed_at || new Date().toISOString();

  if (record.type === "session_meta") {
    const id = record.payload?.session_id || record.payload?.id || sessionIdFromPath(filePath);
    return {
      id: `rollout:${id}`,
      title: titleForMeta(record.payload),
      status: current?.status || "running",
      source: sourceForMeta(record.payload),
      updatedAt: timestamp,
      cwd: record.payload?.cwd,
      path: filePath,
      lastRecordType: recordKey,
    };
  }

  const next = current || {
    id: `rollout:${sessionIdFromPath(filePath)}`,
    title: path.basename(filePath),
    status: "running",
    source: "rollout",
    updatedAt: timestamp,
    path: filePath,
  };

  if (record.type === "turn_context" || payloadType === "task_started" || payloadType === "user_message") {
    return { ...next, status: "running", updatedAt: timestamp, lastRecordType: recordKey };
  }

  if (payloadType === "task_complete" || payloadType === "turn_complete") {
    return { ...next, status: "done", updatedAt: timestamp, lastRecordType: recordKey };
  }

  if (payloadType === "error" || payloadType === "task_failed" || payloadType === "turn_failed") {
    return { ...next, status: "error", updatedAt: timestamp, lastRecordType: recordKey };
  }

  if (isAttentionRecord(record)) {
    return {
      ...next,
      status: "waiting",
      updatedAt: timestamp,
      lastRecordType: recordKey,
      confidence: "rollout-attention-record",
    };
  }

  return { ...next, updatedAt: timestamp, lastRecordType: recordKey };
}

function isAttentionRecord(record) {
  const haystack = [
    record.type,
    record.payload?.type,
    record.payload?.name,
    record.payload?.status,
    record.payload?.reason,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    haystack.includes("approval") ||
    haystack.includes("permission") ||
    haystack.includes("waiting_on_user") ||
    haystack.includes("user_input")
  );
}

function titleForMeta(payload = {}) {
  if (payload.cwd) return path.basename(payload.cwd) || payload.cwd;
  return payload.session_id || payload.id || "Codex rollout";
}

function sourceForMeta(payload = {}) {
  const origin = payload.originator || "Codex";
  return `${origin} rollout`;
}

function sessionIdFromPath(filePath) {
  const match = path.basename(filePath).match(/rollout-.+-(.+)\.jsonl$/);
  return match?.[1] || path.basename(filePath, ".jsonl");
}
