# Codex Usage Status

Codex Usage Status is a tiny local Mac menu bar app for Codex Desktop. It reads your own local Codex session files, runs a small local daemon, and shows whether your Codex threads are done, running, or waiting for you: green means done, yellow means running or possibly waiting, and red means attention is needed.

## Prerequisites

- macOS.
- Node.js 22 or newer.
- Codex Desktop installed and signed in. The installer checks for `~/.codex/auth.json`.

## Install

1. Download and unzip this folder.
2. Open Terminal.
3. Drag this folder into Terminal after typing `cd `, then press Return.
4. Run:

```sh
./install.sh
```

The installer installs daemon dependencies, creates a LaunchAgent for your user account, starts the local status API on port `4173`, and copies `Codex Usage Status.app` to `/Applications` when possible.

## Open The App

Open `Codex Usage Status.app` from `/Applications`.

Because the app is unsigned, macOS Gatekeeper may block the first launch. If that happens, right-click the app, choose Open, then choose Open again in the confirmation dialog. After the first launch, it should open normally.

## Verify

Run:

```sh
curl -s http://127.0.0.1:4173/api/status
```

You should see JSON with an overall status and your recent Codex sessions. If it says the source is offline in the app, rerun `./install.sh` and then try the verify command again.

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

Everything runs locally on your Mac. The daemon reads your own `~/.codex` files and your own Codex account token, writes local status data to `~/.codex-light`, and serves only `127.0.0.1:4173`. Nothing is sent to this project, to the person who shared it with you, or to any separate server.
