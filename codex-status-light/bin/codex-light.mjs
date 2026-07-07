#!/usr/bin/env node
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  applyStaleness,
  clearAllSessions,
  lightSummary,
  readState,
  removeSession,
  resolveDataFile,
  updateSession,
  watchState,
} from "../src/store.mjs";
import { scanRollouts, startRolloutWatcher } from "../collectors/rollout-watcher.mjs";
import { startUsageCollector } from "../collectors/usage-collector.mjs";
import { startIncidentCollector } from "../collectors/incident-collector.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const dataFile = resolveDataFile();
const startedAt = new Date();
const sourceMtimeCache = {
  checkedAt: 0,
  sourceMtime: null,
};

const help = `codex-light

Usage:
  codex-light serve [--port 4173] [--no-rollouts] [--no-usage] [--no-incidents] [--auto-restart|--no-auto-restart]
  codex-light set <session> <idle|running|waiting|done|error> [title]
  codex-light remove <session>
  codex-light clear
  codex-light summary
  codex-light hook <idle|running|waiting|done|error>
  codex-light scan-rollouts
  codex-light demo

Environment:
  CODEX_LIGHT_FILE      Override the JSON status file.
  CODEX_LIGHT_PORT      Override the local API port.
  CODEX_LIGHT_URL       Swift app API endpoint override.
  CODEX_LIGHT_WATCH     Set to 0 to disable rollout watching.
  CODEX_LIGHT_SESSION   Session id used by hook mode.
  CODEX_LIGHT_TITLE     Human readable session title used by hook mode.
`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

async function main(args) {
  const command = args[0] ?? "help";

  if (command === "serve") {
    const port = Number(readFlag(args, "--port") ?? process.env.CODEX_LIGHT_PORT ?? process.env.PORT ?? 4173);
    await serve(port, args);
  } else if (command === "set") {
    const [, sessionId, status, ...titleParts] = args;
    requireValue(sessionId, "Missing session id.");
    requireValue(status, "Missing status.");
    const title = titleParts.join(" ").trim() || sessionId;
    await updateSession(dataFile, {
      id: sessionId,
      title,
      status,
      source: "cli",
    });
    console.log(`${sessionId} -> ${status}`);
  } else if (command === "hook") {
    const status = args[1];
    requireValue(status, "Missing status.");
    const sessionId = process.env.CODEX_LIGHT_SESSION || process.env.CODEX_THREAD_ID || "codex";
    const title = process.env.CODEX_LIGHT_TITLE || process.env.CODEX_WORKSPACE || process.cwd();
    await updateSession(dataFile, {
      id: sessionId,
      title: shortTitle(title),
      status,
      source: "codex-hook",
    });
  } else if (command === "remove") {
    requireValue(args[1], "Missing session id.");
    await removeSession(dataFile, args[1]);
    console.log(`removed ${args[1]}`);
  } else if (command === "clear") {
    await clearAllSessions(dataFile);
    console.log("cleared");
  } else if (command === "summary") {
    const state = await readState(dataFile);
    console.log(JSON.stringify(lightSummary(state), null, 2));
  } else if (command === "scan-rollouts") {
    const sessions = await scanRollouts({ dataFile });
    console.log(JSON.stringify({ sessions, count: sessions.length }, null, 2));
  } else if (command === "demo") {
    await runDemo();
  } else {
    console.log(help);
  }
}

async function serve(port, args) {
  const host = "127.0.0.1";
  const clients = new Set();
  const rolloutsEnabled = process.env.CODEX_LIGHT_WATCH !== "0" && !args.includes("--no-rollouts");
  const stopRolloutWatcher = rolloutsEnabled ? await startRolloutWatcher({ dataFile }) : null;
  let usageCollector = null;
  let incidentCollector = null;
  const usageEnabled = !args.includes("--no-usage");
  const incidentsEnabled = !args.includes("--no-incidents");
  const broadcast = async () => {
    const state = await snapshot({ usageCollector, incidentCollector });
    for (const client of clients) {
      client.write(`data: ${JSON.stringify(state)}\n\n`);
    }
  };
  if (usageEnabled) {
    usageCollector = startUsageCollector({
      onUpdate: () => broadcast().catch(() => {}),
    });
  }
  if (incidentsEnabled) {
    incidentCollector = startIncidentCollector({
      onUpdate: () => broadcast().catch(() => {}),
    });
  }
  const daemonInfo = await buildDaemonInfo();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);

      if (url.pathname === "/api/status") {
        sendJson(response, await snapshot({ usageCollector, incidentCollector }));
        return;
      }

      if (url.pathname === "/api/usage") {
        const usage = usageCollector?.getSnapshot();
        if (!usage) {
          sendJson(response, { error: usageEnabled ? "Usage collector has not produced a snapshot yet" : "Usage collector disabled" }, 503);
          return;
        }
        sendJson(response, usage);
        return;
      }

      if (url.pathname === "/api/incidents") {
        const incidents = incidentCollector?.getSnapshot();
        if (!incidents) {
          sendJson(response, { error: incidentsEnabled ? "Incident collector has not produced a snapshot yet" : "Incident collector disabled" }, 503);
          return;
        }
        sendJson(response, incidents);
        return;
      }

      if (url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        clients.add(response);
        response.write(`data: ${JSON.stringify(await snapshot({ usageCollector, incidentCollector }))}\n\n`);
        request.on("close", () => clients.delete(response));
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        await sendFile(response, "index.html", "text/html; charset=utf-8");
        return;
      }

      if (url.pathname === "/styles.css") {
        await sendFile(response, "styles.css", "text/css; charset=utf-8");
        return;
      }

      if (url.pathname === "/app.js") {
        await sendFile(response, "app.js", "text/javascript; charset=utf-8");
        return;
      }

      response.writeHead(404);
      response.end("Not found");
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : "Unknown error");
    }
  });

  const stopWatching = watchState(dataFile, async () => {
    await broadcast();
  });

  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(`already running at 127.0.0.1:${port}? Use CODEX_LIGHT_PORT=...`);
      process.exit(1);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`Codex Status Light: http://localhost:${port}`);
    console.log(`Version: ${daemonInfo.version}`);
    console.log(`PID: ${daemonInfo.pid}`);
    console.log(`Status file: ${dataFile}`);
    console.log(`Rollout watcher: ${rolloutsEnabled ? "enabled" : "disabled"}`);
    console.log(`Usage collector: ${usageEnabled ? "enabled" : "disabled"}`);
    console.log(`Incident collector: ${incidentsEnabled ? "enabled" : "disabled"}`);
  });

  const close = () => {
    stopWatching();
    stopRolloutWatcher?.();
    usageCollector?.stop();
    incidentCollector?.stop();
    clearInterval(staleCodeTimer);
    server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  // Under launchd (KeepAlive) the process would otherwise keep running old
  // in-memory code forever after an update lands on disk — the exact failure
  // behind the "green while running" incident. Exit cleanly after two
  // consecutive stale checks so launchd restarts us with the new code.
  const autoRestart =
    !args.includes("--no-auto-restart") &&
    (args.includes("--auto-restart") || Boolean(process.env.XPC_SERVICE_NAME));
  let staleChecks = 0;
  const staleCodeTimer = autoRestart
    ? setInterval(async () => {
        try {
          const info = await buildDaemonInfo();
          staleChecks = info.staleCode ? staleChecks + 1 : 0;
          if (staleChecks >= 2) {
            console.log("Source files changed on disk; exiting so launchd restarts the daemon with new code.");
            close();
            process.exit(0);
          }
        } catch {
          // Never let the stale-code check take the daemon down on errors.
        }
      }, 90_000)
    : null;
}

async function runDemo() {
  const sessions = [
    ["desktop-app", "running", "Codex app: build status light"],
    ["docs-check", "waiting", "CLI: approval needed"],
    ["tests", "done", "codex exec: test pass"],
  ];

  for (const [id, status, title] of sessions) {
    await updateSession(dataFile, { id, status, title, source: "demo" });
  }

  console.log("Demo sessions written. Run `npm start` and open the dashboard.");
}

async function snapshot({ usageCollector, incidentCollector } = {}) {
  const generatedAt = new Date();
  const state = await readState(dataFile);
  return {
    ...state,
    generatedAt: generatedAt.toISOString(),
    sessions: applyStaleness(state.sessions, generatedAt),
    summary: lightSummary(state, generatedAt),
    daemon: await buildDaemonInfo(),
    usage: usageCollector?.getSnapshot() ?? null,
    incidents: incidentCollector?.getSnapshot() ?? null,
  };
}

export async function buildDaemonInfo() {
  const [pkg, sourceMtime] = await Promise.all([readPackageJson(), maxSourceMtime()]);
  return {
    version: String(pkg.version || "0.0.0"),
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    sourceMtime: sourceMtime.toISOString(),
    staleCode: sourceMtime.getTime() > startedAt.getTime(),
  };
}

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
}

async function maxSourceMtime() {
  const now = Date.now();
  if (sourceMtimeCache.sourceMtime && now - sourceMtimeCache.checkedAt < 60_000) {
    return sourceMtimeCache.sourceMtime;
  }

  const files = await sourceFiles();
  const mtimes = await Promise.all(files.map(async (file) => {
    try {
      return (await stat(file)).mtimeMs;
    } catch {
      return 0;
    }
  }));
  const sourceMtime = new Date(Math.max(...mtimes, 0));
  sourceMtimeCache.checkedAt = now;
  sourceMtimeCache.sourceMtime = sourceMtime;
  return sourceMtime;
}

async function sourceFiles() {
  const groups = [
    [path.join(rootDir, "bin"), /^codex-light\.mjs$/],
    [path.join(rootDir, "src"), /\.mjs$/],
    [path.join(rootDir, "src", "collectors"), /\.mjs$/],
    [path.join(rootDir, "collectors"), /\.mjs$/],
  ];
  const files = [];
  for (const [dir, pattern] of groups) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && pattern.test(entry.name)) {
          files.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Optional source directories may be absent in packaged installs.
    }
  }
  return files;
}

async function sendFile(response, filename, contentType) {
  const body = await readFile(path.join(publicDir, filename));
  response.writeHead(200, { "Content-Type": contentType });
  response.end(body);
}

function sendJson(response, payload, statusCode = 200) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function requireValue(value, message) {
  if (!value) {
    console.error(message);
    console.error(help);
    process.exit(1);
  }
}

function shortTitle(value) {
  const clean = String(value).trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}
