---
type: architecture
title: Telemetry and dashboard data flow
description: How a task's raw agent output becomes a redacted, verifiable event ledger and how the dashboard renders it.
tags: [architecture, telemetry, dashboard, observability]
timestamp: 2026-08-29
---

# Telemetry and dashboard data flow

Goal (from `docs/TELEMETRY.md`): for every delegated task, record a normalized, tamper-evident
ledger of what the agent actually did — regardless of which executor ran — using a **native
tap** (authoritative, per-agent) cross-checked against a **self-journal** the agent is told to
write itself.

## Harvest (`lib/telemetry.js`)

`telemetry.harvest(agent, taskdir, cwd, startTs)` runs once, right after a task finishes
(`lib/dispatch.js:110`, `lib/dispatch.js:127`, and `lib/warm-daemon.js:127`), and does four
things:

1. **Tap the agent's native output** — one harvester per agent:
   - `harvestCodex()` reads the task's own `events.jsonl` (already captured during the run) and
     maps `item.completed` items (`command_execution` → `command`, `file_change` →
     `file.edit`, `agent_message` → `message.out`) plus `turn.completed.usage` → `llm.usage`
     (`lib/telemetry.js:111-159`).
   - `harvestAntigravity()` has no stdout JSON to read, so it finds the Antigravity
     conversation SQLite db touched during the run window (`~/.gemini/antigravity-cli/
     conversations/<id>.db`), copies it to avoid lock contention, and shells out to `sqlite3`
     to pull the `steps` table; each step's blob columns are decoded as printable-ASCII runs
     and pattern-matched for `write_to_file`/`run_command` payloads
     (`lib/telemetry.js:181-429`, background: `docs/TELEMETRY.md`'s antigravity section).
   - `harvestGeneric()` is the fallback for any other agent's raw JSONL.
2. **Cross-check against the self-journal** — every dispatched agent is instructed (in
   `preamble()`) to append one JSON line per action to `activity.jsonl` in its own working
   directory. `compareSelfReport()` diffs the native tap's actions against that journal and
   flags a large discrepancy as `selfReportGap` in the rollup (`lib/telemetry.js:431-493`).
3. **Redact secrets** — every event passes through `redact()`, which masks known secret key
   names (`api_key`, `password`, `token`, ...) and pattern-matches common token formats
   (`sk-...`, GitHub `ghp_/gho_.../github_pat_...`, GitLab `glpat-...`, Slack `xox[baprs]-...`,
   AWS `AKIA.../ASIA...`, bearer tokens) before anything is written to disk
   (`lib/telemetry.js:75-98`).
4. **Optionally hash-chain** — if `AGENT_BRIDGE_TELEMETRY_VERIFY=1` (set by `run --verify`,
   `bin/agent-bridge.js:112`), each event gets `prevHash`/`hash` (SHA-256 of the event +
   previous hash, genesis = 64 zeros), so tampering with any line breaks the chain on replay
   (`lib/telemetry.js:495-510`).

Output per task: `telemetry.jsonl` (the full redacted, optionally-chained event stream) and
`telemetry.json` (a rollup: `actions`, `commands`, `fileChanges`, `tools`, `filesTouched`,
`tokensIn/Out/cached/reasoning`, `durationSec`, `verified`, `selfReportGap`) — both written by
`harvest()` (`lib/telemetry.js:573-609`).

## Claude's own token accounting (`lib/relay.py`, `lib/otel-claude.py`)

Delegated agents' tokens come from their own event streams; Claude Code's tokens don't, so a
separate path captures them:

- `agent-bridge otel` starts `lib/otel-claude.py`, a small stdlib HTTP server that accepts
  OTLP/HTTP JSON on `:4318` (`bin/agent-bridge.js:311`, `lib/otel-claude.py:1-16`). Claude Code
  must be started with `CLAUDE_CODE_ENABLE_TELEMETRY=1` and `OTEL_EXPORTER_OTLP_ENDPOINT=
  http://localhost:4318` pointed at it (`docs/OTEL_NOTES.md`). It parses the
  `claude_code.token.usage` counter (`type` = input|output|cacheRead|cacheCreation, `model`,
  `session.id`) and upserts cumulative totals into `relay.db`.
- `lib/relay.py` is a shared SQLite bus (`~/.agent-bridge/relay.db` by default, override with
  `RELAY_DB`) with tables for messages (`send`/`poll`/`tail`/`wait` — a Claude↔Codex mailbox
  not wired into the default dispatch flow) and Claude token/cost/lines-of-code tallies fed by
  the OTEL receiver. `agent-bridge tokens` shells out to `relay.py tokens` for a cross-agent
  report (`bin/agent-bridge.js:310`); `dashboard.js` shells out to `relay.py export` for the
  same data in JSON (`lib/dashboard.js:359-375`).

## Dashboard (`lib/dashboard.js`)

A dependency-free HTTP server (stdlib `http`, no build step) that reads the filesystem ledger
and the relay export **live on every request** — nothing is precomputed or cached server-side
(`lib/dashboard.js:1-7`). Routes:

| Route | Returns |
|---|---|
| `GET /` | the self-contained HTML/CSS/JS dashboard (inline, no CDNs) |
| `GET /api/summary` | totals + per-agent token/cost shares + a time-bucketed series |
| `GET /api/sessions` | one row per task (+ Claude sessions from the relay export) |
| `GET /api/task/:id` | one task's frontmatter, status body, result, telemetry rollup, event timeline |

`collectData()` merges delegated-agent tasks (`loadTasks()`, which reads each task's
`telemetry.json` rollup when present, falling back to raw `events.jsonl` stats) with Claude's
relay-sourced sessions, and estimates cost per agent/model from `lib/pricing.json`
(`estimateCost()`, `lib/dashboard.js:94-115` — edit that file if model pricing changes). The
frontend polls `/api/summary` + `/api/sessions` every 4 seconds and renders KPI tiles, a token
donut, a stacked time-series bar chart, and a sortable session table with a task-detail drawer
(`lib/dashboard.js:1009-1256`).

See [Dashboard, service & plugin install](../operations/dashboard-service-and-plugin.md) for
how the dashboard is started/kept running, and
[Task dispatch lifecycle](../workflows/task-dispatch-lifecycle.md) for where in the run
sequence `harvest()` fires.
