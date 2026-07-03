#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
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

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const dataFile = resolveDataFile();

const help = `codex-light

Usage:
  codex-light serve [--port 4173] [--no-rollouts]
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

const args = process.argv.slice(2);
const command = args[0] ?? "help";

if (command === "serve") {
  const port = Number(readFlag("--port") ?? process.env.CODEX_LIGHT_PORT ?? process.env.PORT ?? 4173);
  await serve(port);
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

async function serve(port) {
  const host = "127.0.0.1";
  const clients = new Set();
  const rolloutsEnabled = process.env.CODEX_LIGHT_WATCH !== "0" && !args.includes("--no-rollouts");
  const stopRolloutWatcher = rolloutsEnabled ? await startRolloutWatcher({ dataFile }) : null;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);

      if (url.pathname === "/api/status") {
        sendJson(response, await snapshot());
        return;
      }

      if (url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        clients.add(response);
        response.write(`data: ${JSON.stringify(await snapshot())}\n\n`);
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
    const state = await snapshot();
    for (const client of clients) {
      client.write(`data: ${JSON.stringify(state)}\n\n`);
    }
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
    console.log(`Status file: ${dataFile}`);
    console.log(`Rollout watcher: ${rolloutsEnabled ? "enabled" : "disabled"}`);
  });

  const close = () => {
    stopWatching();
    stopRolloutWatcher?.();
    server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
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

async function snapshot() {
  const generatedAt = new Date();
  const state = await readState(dataFile);
  return {
    ...state,
    generatedAt: generatedAt.toISOString(),
    sessions: applyStaleness(state.sessions, generatedAt),
    summary: lightSummary(state, generatedAt),
  };
}

async function sendFile(response, filename, contentType) {
  const body = await readFile(path.join(publicDir, filename));
  response.writeHead(200, { "Content-Type": contentType });
  response.end(body);
}

function sendJson(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readFlag(name) {
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
