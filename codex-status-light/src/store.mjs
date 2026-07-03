import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";

export const VALID_STATUSES = new Set(["idle", "running", "waiting", "done", "error", "stale"]);
const DEFAULT_RUNNING_STALE_SECONDS = 120;
const ATTENTION_IDLE_SECONDS = 30 * 60;

export function resolveDataFile() {
  return process.env.CODEX_LIGHT_FILE
    ? path.resolve(process.env.CODEX_LIGHT_FILE)
    : path.join(os.homedir(), ".codex-light", "status.json");
}

export async function readState(file) {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
}

export async function updateSession(file, nextSession) {
  if (!VALID_STATUSES.has(nextSession.status)) {
    throw new Error(`Unsupported status "${nextSession.status}".`);
  }

  const state = await readState(file);
  const now = new Date().toISOString();
  const current = state.sessions.find((session) => session.id === nextSession.id);
  const session = {
    id: nextSession.id,
    title: nextSession.title || current?.title || nextSession.id,
    status: nextSession.status,
    source: nextSession.source || current?.source || "manual",
    updatedAt: nextSession.updatedAt || now,
    cwd: nextSession.cwd || current?.cwd,
    path: nextSession.path || current?.path,
    lastRecordType: nextSession.lastRecordType || current?.lastRecordType,
    confidence: nextSession.confidence || current?.confidence,
    detail: nextSession.detail,
  };

  const sessions = [
    session,
    ...state.sessions.filter((existing) => existing.id !== nextSession.id),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  await writeState(file, { sessions, updatedAt: now });
  return session;
}

export async function removeSession(file, sessionId) {
  const state = await readState(file);
  await writeState(file, {
    sessions: state.sessions.filter((session) => session.id !== sessionId),
    updatedAt: new Date().toISOString(),
  });
}

export async function clearAllSessions(file) {
  await writeState(file, emptyState());
}

export function lightSummary(state, now = new Date()) {
  const sessions = applyStaleness(state.sessions, now);
  const counts = Object.fromEntries([...VALID_STATUSES].map((status) => [status, 0]));
  for (const session of sessions) {
    counts[session.status] = (counts[session.status] ?? 0) + 1;
  }

  let status = "idle";
  if (counts.waiting > 0) status = "waiting";
  else if (counts.error > 0) status = "error";
  else if (counts.running > 0) status = "running";
  else if (counts.done > 0) status = "done";

  return {
    status,
    label: labelFor(status),
    counts,
    total: sessions.length,
  };
}

export function applyStaleness(sessions, now = new Date()) {
  const runningTtlSeconds = Number(
    process.env.CODEX_LIGHT_RUNNING_STALE_SECONDS || DEFAULT_RUNNING_STALE_SECONDS
  );
  return sessions.map((session) => {
    if (session.status !== "running" && session.status !== "waiting") return session;
    const updatedAt = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAt)) return session;
    const ageSeconds = (now.getTime() - updatedAt) / 1000;
    if (session.status === "waiting" && (session.detail === "question" || session.detail === "approval")) {
      if (ageSeconds <= ATTENTION_IDLE_SECONDS) return session;
      return {
        ...session,
        status: "idle",
        confidence: session.confidence || "idle-after-attention-timeout",
      };
    }
    if (ageSeconds <= runningTtlSeconds) return session;
    return {
      ...session,
      status: "idle",
      confidence: session.confidence || "idle-after-stale-writer-ttl",
    };
  });
}

export function watchState(file, onChange) {
  const dir = path.dirname(file);
  let watcher;
  let timeout;

  mkdir(dir, { recursive: true }).then(() => {
    watcher = watch(dir, (eventType, filename) => {
      if (filename && filename !== path.basename(file)) return;
      clearTimeout(timeout);
      timeout = setTimeout(onChange, 80);
    });
  });

  return () => {
    clearTimeout(timeout);
    watcher?.close();
  };
}

async function writeState(file, state) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tempFile = path.join(dir, `.status-${process.pid}-${Date.now()}.json`);
  await writeFile(tempFile, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
  await rename(tempFile, file);
}

function normalizeState(state) {
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  return {
    sessions: sessions
      .filter((session) => session?.id && VALID_STATUSES.has(session.status))
      .map((session) => ({
        id: String(session.id),
        title: String(session.title || session.id),
        status: session.status,
        source: String(session.source || "unknown"),
        updatedAt: String(session.updatedAt || new Date(0).toISOString()),
        ...(session.cwd ? { cwd: String(session.cwd) } : {}),
        ...(session.path ? { path: String(session.path) } : {}),
        ...(session.lastRecordType ? { lastRecordType: String(session.lastRecordType) } : {}),
        ...(session.confidence ? { confidence: String(session.confidence) } : {}),
        ...(session.detail ? { detail: String(session.detail) } : {}),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    updatedAt: String(state.updatedAt || new Date().toISOString()),
    host: state.host || os.hostname(),
  };
}

function emptyState() {
  return {
    sessions: [],
    updatedAt: new Date().toISOString(),
    host: os.hostname(),
  };
}

function labelFor(status) {
  return {
    idle: "Idle",
    running: "Running",
    waiting: "Needs attention",
    done: "Done",
    error: "Error",
    stale: "Stale",
  }[status];
}
