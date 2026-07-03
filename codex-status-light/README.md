# Codex Status Light

A small local prototype inspired by the Reddit status-light idea: red when Codex needs attention, yellow while it is working, and green when the run is done or idle.

This version is intentionally hardware-agnostic. It watches local Codex rollout files, writes session status to `~/.codex-light/status.json`, serves a live browser dashboard, and includes Codex hook examples that can later be swapped for LED, Stream Deck, Home Assistant, or serial-device output.

## Run it

```bash
cd codex-status-light
npm start
```

Open `http://localhost:4173`.

Use a different local port:

```bash
CODEX_LIGHT_PORT=4174 npm start
```

The daemon watches `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` by default. To run the server without the rollout collector:

```bash
node ./bin/codex-light.mjs serve --no-rollouts
```

When a completed turn's `last_agent_message` appears to ask a question, the watcher marks the session red with `detail: "question"`. This is a text heuristic, so false positives and false negatives are expected and should be tuned in `looksLikeQuestion()`. Disable it with:

```bash
CODEX_LIGHT_QUESTION_RED=0 npm start
```

Native tool approvals are also marked red immediately when rollout records show a tool call with `sandbox_permissions: "require_escalated"`. Generic dangling shell calls are not enough; long-running commands still rely on the quiet-file heuristic.

Run a one-shot rollout scan:

```bash
node ./bin/codex-light.mjs scan-rollouts
```

Seed a few sample sessions:

```bash
npm run demo
```

Update a session manually:

```bash
node ./bin/codex-light.mjs set my-session running "Codex: refactor API"
node ./bin/codex-light.mjs set my-session waiting "Codex: approval needed"
node ./bin/codex-light.mjs set my-session done "Codex: finished"
```

## Codex hook wiring

Hooks are a secondary signal for CLI sessions. The official hooks API currently documents `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`; there is no `PermissionRequest` hook event.

Enable hooks in `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

1. Copy `examples/hooks.json` into a trusted Codex config layer, such as `~/.codex/hooks.json` or a trusted project `.codex/hooks.json`.
2. Replace `/absolute/path/to/codex-status-light` with this folder's absolute path.
3. Start the dashboard with `npm start`.
4. In Codex CLI, use `/hooks` to review and trust the new command hooks.

Suggested mapping:

- `UserPromptSubmit` and `PreToolUse` -> `running`
- `Stop` -> `done`
- `SessionStart` -> `idle`

For multiple sessions, launch each Codex session with a stable session id:

```bash
CODEX_LIGHT_SESSION=api-refactor CODEX_LIGHT_TITLE="API refactor" codex
```

## Data file

By default the dashboard reads and writes:

```text
~/.codex-light/status.json
```

Override it with:

```bash
CODEX_LIGHT_FILE=/tmp/codex-status.json npm start
```

Use the same `CODEX_LIGHT_FILE` value for the dashboard and hooks.

## Notes

- This is a local dashboard, not a packaged app yet.
- Rollout files, hooks, and the ChatGPT usage endpoints are undocumented or experimental. Parsing is defensive by design.
- Project-local Codex hooks only run when that project `.codex/` layer is trusted.
- The dashboard is dependency-free and uses Server-Sent Events for live updates.
