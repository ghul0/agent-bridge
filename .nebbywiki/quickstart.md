---
type: overview
title: agent-bridge quickstart
description: What agent-bridge is, why it's built as a filesystem work-log, and a map of every wiki section.
tags: [overview, entrypoint]
timestamp: 2026-08-29
---

# agent-bridge

**Claude plans. Agents execute.** `agent-bridge` is a Claude Code plugin (a Node CLI at
`bin/agent-bridge.js`) that delegates coding tasks from Claude Code to executor CLIs —
today **Codex** (`codex`) and **Antigravity** (`agy`) — while Claude stays the planner
([`README.md`](../README.md)).

## Why a filesystem, not a socket?

Every delegated task is just a directory of plain Markdown under `~/.agent-bridge/tasks/<id>/`:

```
task.md       assignment Claude wrote        (frontmatter: agent, cwd, sandbox)
status.md     REWRITABLE progress the agent overwrites at intervals
result.md     final output
events.jsonl  raw agent event stream
telemetry.jsonl / telemetry.json   normalized, redacted action ledger + rollup
artifacts/    files the agent produced
```
(`lib/fslog.js:1-17`)

No daemon has to stay running and nothing has to reconnect — Claude reads files, the agent
writes files. The one contract every executor follows is rewriting `status.md`'s frontmatter
(`status: working|blocked|done|error`, `progress`, `needs_input`) at intervals
(`lib/agents.js:44-84`, the `preamble()` text every agent is launched with).

## The pieces, at a glance

| Piece | Role |
|---|---|
| `bin/agent-bridge.js` | CLI entrypoint — parses `run`/`list`/`status`/`dashboard`/... and calls into `lib/` |
| `lib/dispatch.js` | orchestrates one `run`: creates the task, picks a transport, streams events, finalizes the ledger |
| `lib/agents.js` | the `AGENTS` registry — one entry per executor CLI (build args, parse output, extract session id) |
| `lib/fslog.js` | reads/writes the task ledger and the named-sessions store |
| `lib/telemetry.js` | normalizes each agent's raw output into a redacted, optionally hash-chained action ledger |
| `lib/codex-mcp.js` / `lib/warm-daemon.js` | JSON-RPC client for `codex mcp-server`, and a persistent HTTP daemon that keeps one warm |
| `lib/dashboard.js` | dependency-free local telemetry dashboard, reads the ledger + `relay.py` live |
| `lib/service.js` | starts/stops the dashboard and OTEL receiver as background daemons, wires macOS login autostart |
| `lib/relay.py` / `lib/otel-claude.py` | SQLite message bus + Claude's own OTLP token receiver |
| `skills/codex-send/`, `skills/agy-send/` | the Claude Code skills a human actually invokes (`/codex-send`, `/agy-send`) |

## Map of this wiki

- [Architecture overview](architecture/overview.md) — how the CLI, dispatcher, agent
  registry, and task ledger fit together; transport selection (MCP vs `exec` vs plain CLI).
- [Telemetry & dashboard](architecture/telemetry-and-dashboard.md) — how one task's raw
  output becomes a redacted, verifiable event ledger, and how the dashboard renders it.
- [CLI reference](api/cli-reference.md) — every `agent-bridge` subcommand.
- [Agent registry contract](api/agent-registry.md) — what a new executor entry must
  implement to plug into `agent-bridge`.
- [Task dispatch lifecycle](workflows/task-dispatch-lifecycle.md) — the end-to-end sequence
  of one `agent-bridge run`, from CLI invocation to a finished ledger.
- [Sessions, worktrees & PRs](workflows/sessions-worktrees-and-pr.md) — `--session` reuse,
  the warm Codex daemon, `--isolate` git worktrees, and the `--pr` flow.
- [Dashboard, service & plugin install](operations/dashboard-service-and-plugin.md) —
  running the dashboard as a background service, `agent-bridge install`, and the Claude
  Code plugin/skill packaging.

## Backlog

- The wiki doesn't yet cover `lib/pricing.json` cost-table maintenance in depth (only
  mentioned in passing in the dashboard page) — worth its own note if pricing drifts often.
- `docs/CODEX_MCP_BRIDGE_ARCHITECTURE.md` (772 lines) has design rationale and rejected
  alternatives beyond what's summarized here; read it directly for the full history.
- The removed `gemini` agent entry (`lib/agents.js:124-126`) is documented only as a
  comment — no wiki page tracks it since it isn't live code.
