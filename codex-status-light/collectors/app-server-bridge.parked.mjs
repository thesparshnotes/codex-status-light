#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const statusLightDir = path.resolve(scriptDir, "..");
const storeModule = await import(path.join(statusLightDir, "src/store.mjs"));
const dataFile = storeModule.resolveDataFile();

const args = parseArgs(process.argv.slice(2));
const pollMs = Number(args["poll-ms"] ?? 1500);
const once = Boolean(args.once);
const includeNotLoaded = Boolean(args["include-not-loaded"]);
const transport = args.transport ?? "stdio";
const logEvents = Boolean(args["log-events"]);

const sourceKinds = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

const threadCache = new Map();
const pending = new Map();
const liveThreadIds = new Set();
let nextId = 1;
let stopping = false;

const proc = spawnCodex();
const rl = createInterface({ input: proc.stdout });

proc.stderr.on("data", (chunk) => {
  const text = chunk.toString().trim();
  if (text) console.error(text);
});

proc.on("exit", (code, signal) => {
  if (!stopping) {
    console.error(`codex app-server exited: code=${code} signal=${signal}`);
    process.exitCode = code ?? 1;
  }
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error(`non-json app-server line: ${line}`);
    return;
  }

  if (logEvents) {
    console.error(JSON.stringify(message));
  }

  if (message.id != null && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }

  void handleServerMessage(message);
});

await initialize();
await pollThreads();

if (once) {
  await shutdown();
} else {
  setInterval(() => {
    void pollThreads();
  }, pollMs);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function spawnCodex() {
  if (transport === "proxy") {
    const command = ["app-server", "proxy"];
    if (args.sock) command.push("--sock", args.sock);
    return spawn("codex", command, { stdio: ["pipe", "pipe", "pipe"] });
  }

  return spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
}

async function initialize() {
  await send("initialize", {
    clientInfo: {
      name: "codex_status_light_bridge",
      title: "Codex Status Light Bridge",
      version: "0.2.0",
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  });
  notify("initialized");
}

async function pollThreads() {
  const loaded = await send("thread/loaded/list", { limit: 200 });
  liveThreadIds.clear();
  if (Array.isArray(loaded.result?.data)) {
    for (const threadId of loaded.result.data) {
      liveThreadIds.add(threadId);
    }
  }

  const listed = await send("thread/list", {
    limit: 100,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds,
    archived: false,
    useStateDbOnly: false,
  });

  if (!Array.isArray(listed.result?.data)) {
    return;
  }

  let wroteAnyLive = false;
  for (const thread of listed.result.data) {
    threadCache.set(thread.id, thread);
    if (!includeNotLoaded && thread.status?.type === "notLoaded" && !liveThreadIds.has(thread.id)) {
      continue;
    }
    await writeThreadStatus(thread, thread.status, "poll");
    wroteAnyLive = true;
  }

  if (!wroteAnyLive) {
    await storeModule.updateSession(dataFile, {
      id: "appserver:bridge",
      title: "App-server bridge: no live loaded threads",
      status: "done",
      source: "app-server-bridge",
    });
  }
}

async function handleServerMessage(message) {
  switch (message.method) {
  case "thread/started":
    threadCache.set(message.params.thread.id, message.params.thread);
    await writeThreadStatus(message.params.thread, message.params.thread.status, "thread/started");
    break;
  case "thread/statusChanged": {
    const thread = threadCache.get(message.params.threadId) ?? { id: message.params.threadId };
    await writeThreadStatus(thread, message.params.status, "thread/statusChanged");
    break;
  }
  case "turn/started": {
    const thread = threadCache.get(message.params.threadId) ?? { id: message.params.threadId };
    await writeThreadStatus(thread, { type: "active", activeFlags: [] }, "turn/started");
    break;
  }
  case "turn/completed": {
    const thread = threadCache.get(message.params.threadId) ?? { id: message.params.threadId };
    const turnStatus = message.params.turn?.status;
    const status = turnStatus === "failed"
      ? "error"
      : "done";
    await writeStatus(thread, status, "turn/completed");
    break;
  }
  case "thread/nameUpdated": {
    const thread = threadCache.get(message.params.threadId) ?? { id: message.params.threadId };
    thread.name = message.params.threadName ?? thread.name;
    threadCache.set(thread.id, thread);
    break;
  }
  case "item/commandExecution/requestApproval":
  case "item/fileChange/requestApproval":
  case "item/permissions/requestApproval":
  case "item/tool/requestUserInput": {
    const threadId = message.params?.threadId ?? message.params?.conversationId ?? "unknown";
    const thread = threadCache.get(threadId) ?? { id: threadId };
    await writeStatus(thread, "waiting", message.method);
    break;
  }
  default:
    break;
  }
}

async function writeThreadStatus(thread, status, source) {
  const mapped = mapThreadStatus(status);
  if (!mapped) return;
  await writeStatus(thread, mapped, source);
}

async function writeStatus(thread, status, source) {
  const id = `appserver:${thread.id}`;
  await storeModule.updateSession(dataFile, {
    id,
    title: threadTitle(thread),
    status,
    source: `app-server:${source}`,
  });
}

function mapThreadStatus(status) {
  switch (status?.type) {
  case "active":
    if ((status.activeFlags ?? []).includes("waitingOnApproval")) return "waiting";
    if ((status.activeFlags ?? []).includes("waitingOnUserInput")) return "waiting";
    return "running";
  case "idle":
    return "done";
  case "systemError":
    return "error";
  case "notLoaded":
    return includeNotLoaded ? "idle" : null;
  default:
    return null;
  }
}

function threadTitle(thread) {
  const title = thread.name || thread.preview || thread.id || "Unknown Codex thread";
  return String(title).replace(/\s+/g, " ").trim().slice(0, 96);
}

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ id, error: { message: "timeout" } });
      }
    }, 12_000);
  });
}

function notify(method, params = {}) {
  proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
}

async function shutdown() {
  stopping = true;
  proc.kill("SIGTERM");
  process.exit(0);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
