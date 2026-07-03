# Codex Usage Status

A small macOS menu-bar app that combines Codex usage with a fast-refresh status light.

## Run

```sh
swift run
```

Or build a double-clickable menu-bar bundle:

```sh
Scripts/build-bundle.sh
open -n "dist/Codex Usage Status.app"
```

## Open At Login

Build the app bundle, then install the included LaunchAgent:

```sh
Scripts/build-bundle.sh
Scripts/install-login-item.sh
```

The login item opens `dist/Codex Usage Status.app` when you sign in after a restart.

To remove it:

```sh
Scripts/uninstall-login-item.sh
```

The app reads `~/.codex/auth.json` locally and uses `tokens.access_token` only as a Bearer token for read-only backend requests. It reads the status light from the local `codex-status-light` server first, then falls back to the JSON file.

Start the status-light server before opening the menu-bar app:

```sh
cd ../codex-status-light
npm start
```

Default status API:

```text
http://127.0.0.1:4173/api/status
```

Set `CODEX_LIGHT_URL` before launching the app if you want to point it at another status server.

Fallback status file:

```text
../codex-status-light/data/status.json
```

Set `CODEX_LIGHT_FILE` before launching the app if you want to point the fallback file reader at another status file.

Fetched endpoints:

- `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
- `https://chatgpt.com/backend-api/wham/usage`

It does not call `/rate-limit-reset-credits/consume`.

## Notifications

The app asks macOS for notification permission on launch.

Weekly usage notifications are sent:

- At 80% weekly usage
- At 95% weekly usage

Each threshold alerts only once per weekly reset window. The alert includes the weekly percentage used, approximate percentage remaining, reset time, and available reset-credit count.

## Current Scope

- 5-hour usage percentage and reset time
- Weekly usage percentage and reset time
- Reset credit count
- Per-credit title, status, local grant/expiry times, and raw UTC grant/expiry values
- Automatic refresh every 5 minutes
- Manual refresh from the popover
- Weekly usage notifications at 80% and 95%
- Fast status refresh every second
- Menu-bar icon color: red for attention, yellow for running, green for done/idle
- Popover background tint follows the current status
