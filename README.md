# Codex Status Light

![Codex Status Light demo](assets/lock-close.gif)

Codex Status Light is a tiny local Mac menu bar app for Codex Desktop. It reads your own local Codex session files, runs a small local daemon, and shows whether your Codex threads are done, running, or waiting for you: green means done, yellow means running or possibly waiting, and red means attention is needed.

It also shows your **usage** at a glance for both **Codex and Claude** — 5‑hour and weekly windows, with the exact reset time and a live countdown — plus a badge when OpenAI or Anthropic is having an incident.

## What you get

- **Attention traffic light** for your Codex sessions (green / yellow / red), computed by the daemon from your local rollout files. Subagent sessions are labelled by nickname.
- **Usage for Codex and Claude** side by side: session (5‑hour) and weekly windows, percent used, exact reset time, and a countdown like `(in 2h 14m)`. Codex reset credits are listed under a click‑to‑expand row.
- **Provider incidents**: if `status.openai.com` or `status.claude.com` reports an incident, the affected section shows a banner (click to open the status page) and a small `!` on that provider's logo.
- **Menu bar pill**: a subtle green/yellow/red background with the Codex and Claude logos and their percentages.
- **Self‑healing daemon**: it restarts itself when its code is updated, and refreshes the Claude token automatically when it expires.

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

You should see JSON with an overall status, your recent Codex sessions, a `usage` block for Codex and Claude, an `incidents` block, and a `daemon` block. There are also two focused endpoints: `http://127.0.0.1:4173/api/usage` and `http://127.0.0.1:4173/api/incidents`. If the app says the source is offline, rerun `./install.sh` and try again.

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

Everything runs locally on your Mac. The daemon reads your own `~/.codex` files and your own Codex and Claude account tokens, writes local status data to `~/.codex-light`, and serves only `127.0.0.1:4173`. It fetches usage directly from OpenAI and Anthropic using your own tokens, and reads provider incident status from the public OpenAI/Anthropic status pages. When your Claude token expires, the daemon refreshes it and updates the Keychain item in place (the same way Claude Code does). Nothing is sent to this project, to the person who shared it with you, or to any separate server.
