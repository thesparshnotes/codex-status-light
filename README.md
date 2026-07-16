# Codex Status Light

![Codex Status Light demo](assets/lock-close.gif)

Codex Status Light is a tiny local Mac menu bar app for Codex Desktop. It reads your own local Codex session files, runs a small local daemon, and shows whether your Codex threads are done, running, or waiting for you: green means done, yellow means running or possibly waiting, and red means attention is needed.

It also shows your **usage** at a glance for both **Codex and Claude** — session and weekly windows, with the exact reset time and a live countdown — **projects when you will run out**, tells you **what to do about it**, and badges provider incidents.

## What you get

- **Attention traffic light** for your Codex sessions (green / yellow / red), computed by the daemon from your local rollout files. Subagent sessions are labelled by nickname.
- **Usage for Codex and Claude** side by side: session and weekly windows (including model‑scoped weeklies), percent used, exact reset time, and a countdown like `(in 2h 14m)`. Codex reset credits are listed under a click‑to‑expand row.
- **Burn‑rate projection** under every weekly window: your recent pace leads, with the week average alongside — e.g. `Last 24h 9.4%/day — runs out Fri 18:20 · Week avg 3.1%/day`. Once it has learned your habits it adds `≈4.2 heavy days of budget left` (the median of your actual working days, so idle days don't flatter the number). It says `collecting burst data` rather than guessing while history builds.
- **Strategy line** — the point of the whole thing. A local rules engine reads both providers and tells you what to *do*: spend a reset credit before it expires, front‑load work against a weekly that's about to reset unused, shift execution to the provider with headroom, or slow down and defer past a reset. It can show two complementary lines at once (e.g. *"spend the credit expiring Saturday"* + *"Claude resets Friday with ~88% unused — front‑load queued work"*). Optionally rephrased by a **local** LLM if you run one (see below); never by a paid API.
- **Provider incidents**: if `status.openai.com` or `status.claude.com` reports an incident, the affected section shows a banner (click to open the status page) and a small `!` on that provider's logo.
- **Menu bar pill**: a subtle green/yellow/red background with the Codex and Claude logos and their percentages.
- **Self‑healing daemon**: it restarts itself when its code is updated, and refreshes the Claude token automatically when it expires.

### Optional: local phrasing model

The strategy engine writes its own advice and works fully offline with no extra setup. If you happen to run a local OpenAI‑compatible server (LM Studio, Ollama, vLLM…) on `http://localhost:8080`, the daemon will use it to reword that advice more naturally — at zero cost, and only if the reworded text still contains every fact, date and number from the original (otherwise it keeps its own wording). Point it elsewhere with `CODEX_LIGHT_LLM_URL`, or turn it off with `CODEX_LIGHT_LLM=0`. **No paid API is ever called for advice.**

## Prerequisites

- macOS (Apple Silicon for the prebuilt app; Intel users can rebuild from source).
- Node.js 22 or newer.
- Codex Desktop installed and signed in. The installer checks for `~/.codex/auth.json`.
- **Optional, for Claude usage**: Claude Code installed and signed in (`claude`). The daemon reads Claude's usage token from your login Keychain item `Claude Code-credentials`; macOS may prompt once to allow access — choose **Always Allow**. Without Claude Code, the Codex half still works and the Claude section simply shows as unavailable.

## Install

1. Download and unzip this folder.
2. Open Terminal.
3. Drag this folder into Terminal after typing `cd `, then press Return.
4. Run:

```sh
./install.sh
```

The installer installs daemon dependencies, creates a LaunchAgent for your user account, starts the local status API on port `4173`, and copies the bundled app to `/Applications` when possible.

## Open The App

Open `Codex Usage Status.app` from `/Applications`.

The bundled app file is currently named `Codex Usage Status.app`, but the project name is Codex Status Light.

Because the app is unsigned, macOS Gatekeeper may block the first launch. If that happens, right-click the app, choose Open, then choose Open again in the confirmation dialog. After the first launch, it should open normally.

## Verify

Run:

```sh
curl -s http://127.0.0.1:4173/api/status
```

You should see JSON with an overall status, your recent Codex sessions, a `usage` block for Codex and Claude (each weekly window carrying its own `projection`, plus a top‑level `strategy`), an `incidents` block, and a `daemon` block. There are also two focused endpoints: `http://127.0.0.1:4173/api/usage` and `http://127.0.0.1:4173/api/incidents`. If the app says the source is offline, rerun `./install.sh` and try again.

## Uninstall

From this same folder, run:

```sh
./uninstall.sh
```

The uninstaller unloads the LaunchAgent, removes `~/.codex-light/`, and removes `/Applications/Codex Usage Status.app` if it was copied there.

## Rebuild The App

The prebuilt app is included so you do not need Xcode. If you do want to rebuild it, the Swift source is in `swift-source/`.

The included prebuilt app is for Apple Silicon Macs. Intel Mac users can still use the daemon, but should rebuild the app from source on their own Mac.

```sh
cd swift-source
Scripts/build-bundle.sh
```

## Privacy

Everything runs locally on your Mac. The daemon reads your own `~/.codex` files and your own Codex and Claude account tokens, writes local status data to `~/.codex-light`, and serves only `127.0.0.1:4173`. It fetches usage directly from OpenAI and Anthropic using your own tokens, reads provider incident status from the public OpenAI/Anthropic status pages, and stores a small usage history (`~/.codex-light/usage-history.jsonl`, 30‑day retention) locally so it can project your burn rate. When your Claude token expires, the daemon refreshes it and updates the Keychain item in place (the same way Claude Code does). Nothing is sent to this project, to the person who shared it with you, or to any separate server.
