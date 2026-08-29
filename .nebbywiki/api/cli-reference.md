---
type: api
title: CLI reference
description: Every agent-bridge subcommand, its flags, and what it calls into.
tags: [api, cli]
timestamp: 2026-08-29
---

# CLI reference

All commands are subcommands of the `agent-bridge` binary (`bin/agent-bridge.js`, installed
via `bin.agent-bridge` in `package.json`, or run directly with `node bin/agent-bridge.js`).
The full usage text lives in `usage()` (`bin/agent-bridge.js:39-70`); this page adds what each
command actually does.

## `run` — delegate a task

```
agent-bridge run --agent <codex|antigravity> "<task>"
  [-C <dir>] [-s read-only|workspace-write] [--model <name>]
  [--transport mcp|exec] [--verify]
  [--isolate] [--pr] [--session <name>]
```

Parsed by `parseRun()` (`bin/agent-bridge.js:75-92`) and executed by `dispatch()` — see
[Architecture overview](../architecture/overview.md) and
[Task dispatch lifecycle](../workflows/task-dispatch-lifecycle.md).

- `--agent` — required, must be a key in `AGENTS` (`codex` or `antigravity`).
- `-C <dir>` — working directory for the task (default: cwd).
- `-s` — sandbox: `read-only` (inspection, no edits) or `workspace-write` (default; edits
  auto-approved).
- `--model` — passed through to the executor's model flag.
- `--transport` — Codex only; `mcp` (default, warm JSON-RPC server) or `exec` (fallback,
  `codex exec --json` per turn). Rejected for any other agent
  (`effectiveTransport()`, `lib/dispatch.js:56-60`).
- `--verify` — sets `AGENT_BRIDGE_TELEMETRY_VERIFY=1` so the telemetry harvest hash-chains
  every event (`bin/agent-bridge.js:112`).
- `--isolate` — run in a private git worktree + branch (`agent-bridge/<taskId>`); requires the
  target dir to be a git repo.
- `--pr` — implies `--isolate`; after a successful run, commit, push, and open a PR with `gh`.
- `--session <name>` — reuse (or create) a named session: same agent conversation/thread and
  the same worktree across multiple `run` calls. See
  [Sessions, worktrees & PRs](../workflows/sessions-worktrees-and-pr.md).

## `sessions` — list reusable sessions

`agent-bridge sessions` prints every entry in `sessions.json` (name, agent, turn count,
session id) via `fslog.listSessions()` (`bin/agent-bridge.js:94-101`).

## `warm` — persistent Codex MCP daemon

```
agent-bridge warm up|down|status
agent-bridge warm send --session <name> [-C dir] [-s sandbox] "<prompt>"
```

`up`/`down` start/stop a background daemon (`lib/warm-daemon.js`) that holds one long-lived
`codex mcp-server` and routes named sessions to it as threads over local HTTP
(`bin/agent-bridge.js:216-251`). `send` auto-starts the daemon if it isn't already listening
on `WARM_PORT` (default `7677`) and posts to `/send`. See
[Sessions, worktrees & PRs](../workflows/sessions-worktrees-and-pr.md) for how this differs
from `run --session`.

## `list` / `status` / `result` / `watch` — inspect tasks

- `agent-bridge list` — every task's status/progress/agent, newest first
  (`fslog.listTasks()`, `bin/agent-bridge.js:125-132`).
- `agent-bridge status [<id>|latest]` — prints that task's `status.md` verbatim.
- `agent-bridge result [<id>|latest]` — prints that task's `result.md` verbatim.
- `agent-bridge watch [<id>|latest]` — polls `status.md` every second and reprints it when it
  changes (`bin/agent-bridge.js:142-151`).

`id` defaults to `latest`, resolved via the `~/.agent-bridge/latest` symlink or the most
recent task directory (`fslog.taskDir()`, `lib/fslog.js:116-123`).

## `tokens` / `otel` — Claude token accounting

- `agent-bridge tokens` — shells out to `lib/relay.py tokens` for a cross-agent token/cost
  report.
- `agent-bridge otel` — starts `lib/otel-claude.py`, the local OTLP/HTTP receiver Claude Code
  should be pointed at. See
  [Telemetry and dashboard data flow](../architecture/telemetry-and-dashboard.md).

## `dashboard` / `up` / `down` / `open` / `autostart` / `service` — the telemetry UI

- `agent-bridge dashboard [--port n] [--open]` — runs the dashboard **in the foreground**
  (debugging); calls `lib/dashboard.js`'s `startServer()`.
- `agent-bridge up [--port n] [--open]` — starts the dashboard + OTEL receiver as detached
  background daemons (idempotent) via `lib/service.js`.
- `agent-bridge down` — stops both daemons.
- `agent-bridge open` — ensures the dashboard is running, then opens it in the browser
  (`open` on macOS, `xdg-open` elsewhere).
- `agent-bridge autostart [on|off]` — installs/removes a macOS `launchd` login agent for the
  dashboard; on Linux, prints a systemd-user-unit suggestion instead
  (`lib/service.js:126-149`).
- `agent-bridge service status` — is the dashboard listening, and is autostart on?

Full detail: [Dashboard, service & plugin install](../operations/dashboard-service-and-plugin.md).

## `install` / `doctor`

- `agent-bridge install` — runs `doctor()`, registers `codex-direct` as a direct-MCP escape
  hatch (if `codex` is on PATH), copies `skills/*/SKILL.md` into the user's global skill
  directory, and turns on the dashboard (autostart on macOS, background `up` elsewhere)
  (`bin/agent-bridge.js:263-289`).
- `agent-bridge doctor` — checks whether `codex`, `agy`, and `claude` are on PATH
  (`bin/agent-bridge.js:291-298`).

## Environment variables

| Variable | Effect |
|---|---|
| `AGENT_BRIDGE_HOME` | root for tasks/sessions/dashboard config (default `~/.agent-bridge`) |
| `RELAY_DB` | path to the SQLite relay db (default `<AGENT_BRIDGE_HOME>/relay.db`) |
| `AGENT_BRIDGE_TELEMETRY_VERIFY` | `1`/`true`/`yes` enables the telemetry hash chain |
| `WARM_PORT` | port for the warm Codex daemon's HTTP API (default `7677`) |
| `OTEL_PORT` | port `otel-claude.py` listens on (default `4318`) |
