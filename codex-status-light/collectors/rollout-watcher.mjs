#!/usr/bin/env node
import { watch } from "node:fs";
import { access, mkdir, open, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { deriveStatus, parseLine, reduceSession } from "../src/rollout.mjs";
import { readState, removeSession, resolveDataFile, updateSession } from "../src/store.mjs";

const RECOMPUTE_MS = 5000;
const DONE_PRUNE_MS = 10 * 60 * 1000;
const STORE_LIMIT = 50;

export async function startRolloutWatcher({ dataFile = resolveDataFile(), codexHome = resolveCodexHome() } = {}) {
  const watcher = new RolloutWatcher({ dataFile, codexHome });
  await watcher.start();
  return () => watcher.stop();
}

export async function scanRollouts({ dataFile = resolveDataFile(), codexHome = resolveCodexHome() } = {}) {
  const watcher = new RolloutWatcher({ dataFile, codexHome });
  await watcher.scanTodayFromStart();
  await watcher.recompute();
  return [...watcher.files.values()].map((file) => toStoreSession(file, deriveStatus(file.state, Date.now())));
}

class RolloutWatcher {
  constructor({ dataFile, codexHome }) {
    this.dataFile = dataFile;
    this.codexHome = codexHome;
    this.sessionsRoot = path.join(codexHome, "sessions");
    this.files = new Map();
    this.watcher = null;
    this.interval = null;
    this.midnightTimer = null;
    this.closed = false;
    this.watchedDir = null;
  }

  async start() {
    await this.scanTodayFromStart();
    await this.recompute();
    await this.watchToday();
    this.interval = setInterval(() => this.scanAndRecompute().catch(() => {}), RECOMPUTE_MS);
    this.scheduleMidnightRefresh();
  }

  stop() {
    this.closed = true;
    this.watcher?.close();
    clearInterval(this.interval);
    clearTimeout(this.midnightTimer);
  }

  async scanTodayFromStart() {
    await this.scanToday({ fromStart: true });
  }

  async scanToday({ fromStart = false } = {}) {
    const dir = todayDirectory(this.sessionsRoot);
    const files = await listRolloutFiles(dir);
    for (const file of files) {
      await this.ensureFile(file, { fromStart });
      await this.tailFile(file);
    }
  }

  async watchToday() {
    this.watcher?.close();
    const dir = todayDirectory(this.sessionsRoot);
    this.watchedDir = await nearestExistingAncestor(dir);
    this.watcher = watch(this.watchedDir, { persistent: true }, () => {
      this.scanAndRecompute().catch(() => {});
    });
  }

  async scanAndRecompute() {
    if (this.closed) return;
    await this.scanToday();
    await this.recompute();
  }

  async ensureFile(file, { fromStart = false } = {}) {
    if (!this.files.has(file) || fromStart) {
      this.files.set(file, {
        file,
        offset: 0,
        partial: "",
        state: undefined,
        lastWrittenStatus: null,
        lastWrittenActivityAt: 0,
        terminalSince: null,
      });
    }
  }

  async tailFile(file) {
    const tracked = this.files.get(file);
    if (!tracked) return;

    const info = await stat(file);
    if (info.size < tracked.offset) {
      tracked.offset = 0;
      tracked.partial = "";
      tracked.state = undefined;
    }
    if (info.size === tracked.offset) return;

    const handle = await open(file, "r");
    try {
      const length = info.size - tracked.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, tracked.offset);
      tracked.offset = info.size;
      const text = tracked.partial + buffer.toString("utf8");
      const lines = text.split(/\r?\n/);
      tracked.partial = lines.pop() || "";
      for (const line of lines) {
        if (!line) continue;
        const record = parseLine(line);
        if (!record) continue;
        tracked.state = reduceSession(tracked.state, record);
      }
    } finally {
      await handle.close();
    }
  }

  async recompute() {
    const now = Date.now();
    for (const file of [...this.files.keys()]) {
      await this.tailFile(file);
      const tracked = this.files.get(file);
      if (!tracked?.state?.id) continue;
      if (tracked.state.isGuardian) continue;
      if (!this.isNewestRolloutForSession(tracked)) continue;

      const status = deriveStatus(tracked.state, now);
      if (status === "done" || status === "idle") {
        tracked.terminalSince ||= now;
      } else {
        tracked.terminalSince = null;
      }

      if (tracked.terminalSince && now - tracked.terminalSince > DONE_PRUNE_MS) {
        this.files.delete(file);
        continue;
      }

      const lastActivityAt = tracked.state.lastActivityAt || now;
      if (tracked.lastWrittenStatus === status && tracked.lastWrittenActivityAt === lastActivityAt) {
        continue;
      }

      await updateSession(this.dataFile, toStoreSession(tracked, status));
      tracked.lastWrittenStatus = status;
      tracked.lastWrittenActivityAt = lastActivityAt;
    }

    await pruneStoreIfNeeded(this.dataFile);
  }

  isNewestRolloutForSession(tracked) {
    const sessionId = tracked.state?.id;
    if (!sessionId) return true;
    for (const other of this.files.values()) {
      if (other === tracked || other.state?.id !== sessionId) continue;
      if (other.state?.isGuardian) continue;
      if (compareRolloutPaths(other.file, tracked.file) > 0) return false;
    }
    return true;
  }

  scheduleMidnightRefresh() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setDate(now.getDate() + 1);
    midnight.setHours(0, 0, 2, 0);
    this.midnightTimer = setTimeout(async () => {
      if (this.closed) return;
      await this.watchToday();
      await this.scanAndRecompute();
      this.scheduleMidnightRefresh();
    }, midnight.getTime() - now.getTime());
  }
}

export function toStoreSession(tracked, status) {
  const sessionId = tracked.state.id;
  const shortId = String(sessionId).slice(0, 8);
  const cwdBase = tracked.state.cwd ? path.basename(tracked.state.cwd) : "Codex";
  const baseTitle = tracked.state.agentNickname
    ? `${tracked.state.agentNickname} ⤷ ${cwdBase} ${shortId}`
    : `${cwdBase} ${shortId}`;
  const isQuestion = status === "waiting" && tracked.state.detail === "question";
  const isApproval = status === "waiting" && tracked.state.detail === "approval";
  return {
    id: `rollout:${sessionId}`,
    title: isQuestion
      ? `${baseTitle} — asked a question`
      : isApproval
        ? `${baseTitle} — awaiting approval`
        : status === "waiting"
          ? `Possibly waiting: ${baseTitle}`
          : baseTitle,
    status,
    source: "rollout-watcher",
    updatedAt: new Date(tracked.state.lastActivityAt || Date.now()).toISOString(),
    cwd: tracked.state.cwd,
    path: tracked.file,
    ...(tracked.state.parentThreadId ? { parentId: `rollout:${tracked.state.parentThreadId}` } : {}),
    confidence: isQuestion
      ? "question-heuristic"
      : isApproval
        ? "approval-record"
        : status === "waiting"
          ? "heuristic-file-quiet"
          : undefined,
    detail: isQuestion ? "question" : isApproval ? "approval" : undefined,
  };
}

async function pruneStoreIfNeeded(dataFile) {
  const state = await readState(dataFile);
  if (state.sessions.length <= STORE_LIMIT) return;

  const removable = state.sessions
    .filter((session) => session.status === "done" || session.status === "idle")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const session of removable.slice(0, state.sessions.length - STORE_LIMIT)) {
    await removeSession(dataFile, session.id);
  }
}

async function listRolloutFiles(dir) {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((entry) => /^rollout-.*\.jsonl$/.test(entry))
      .map((entry) => path.join(dir, entry))
      .sort(compareRolloutPaths);
  } catch {
    return [];
  }
}

function compareRolloutPaths(a, b) {
  const byTime = rolloutTimeFromPath(a) - rolloutTimeFromPath(b);
  return byTime || a.localeCompare(b);
}

function rolloutTimeFromPath(filePath) {
  const match = path.basename(filePath).match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  if (!match) return 0;
  const isoish = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3.000Z");
  const time = Date.parse(isoish);
  return Number.isFinite(time) ? time : 0;
}

async function nearestExistingAncestor(dir) {
  let current = dir;
  while (true) {
    try {
      await access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        await mkdir(dir, { recursive: true });
        return dir;
      }
      current = parent;
    }
  }
}

function todayDirectory(root) {
  const now = new Date();
  return path.join(
    root,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );
}

function resolveCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = await startRolloutWatcher();
  console.log("Codex rollout watcher running.");
  const close = () => {
    stop();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
