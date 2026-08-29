---
type: operations
title: Dashboard service, install, and the Claude Code plugin
description: How the dashboard is kept running as a background service, what `install` does, and how the plugin/skills are packaged.
tags: [operations, dashboard, install, plugin]
timestamp: 2026-08-29
---

# Dashboard service, install, and the Claude Code plugin

## Running the dashboard as a service (`lib/service.js`)

The dashboard (see
[Telemetry and dashboard data flow](../architecture/telemetry-and-dashboard.md)) can run in
the foreground for debugging (`agent-bridge dashboard`) or as a managed background daemon:

- **`up({port})`** — idempotent: checks if something is already listening on the target port
  (`portListening()`, a raw TCP connect probe) and only spawns a new `dashboard` daemon if not;
  always also (re)starts the `otel` daemon (`lib/service.js:76-90`).
- **Daemons are tracked by pidfile** (`startDaemon()`/`stopDaemon()`, `lib/service.js:50-74`):
  each is `spawn(process.execPath, [BIN, ...args], {detached: true, ...})`, unref'd, with its
  pid written to `$AGENT_BRIDGE_HOME/<name>.pid` and output appended to `$AGENT_BRIDGE_HOME/
  <name>.log`.
- **`down()`** kills both by pidfile.
- **`autostartOn()`** — on macOS, writes a `launchd` plist
  (`~/Library/LaunchAgents/com.agent-bridge.dashboard.plist`, `RunAtLoad` + `KeepAlive`) and
  loads it, after first stopping any manually-started dashboard daemon so launchd can bind the
  port itself (`lib/service.js:126-141`). On Linux there's no automatic autostart — it prints
  the systemd-user-unit command to run manually and notes that `agent-bridge up` keeps it alive
  until logout (`lib/service.js:129-134`).
- **`status(cb)`** reports whether the port is listening, whether autostart is configured, and
  whether the macOS launch agent plist exists.

`agent-bridge up/down/autostart/service` (see [CLI reference](../api/cli-reference.md)) are
thin wrappers over this module.

## `agent-bridge install`

The one-command setup path (`bin/agent-bridge.js:263-289`):

1. Runs `doctor()` to report which executor CLIs are present.
2. If `codex` is on PATH, registers a `codex-direct` Claude MCP server (`claude mcp add
   codex-direct --scope user -- codex mcp-server -c approval_policy=never -c
   sandbox_mode=workspace-write`) as an **escape hatch** — the canonical path is still
   Claude Code → `/codex-send` → `agent-bridge` → Codex MCP, because a direct MCP connection
   bypasses the bridge's task ledger and dashboard (`bin/agent-bridge.js:266-272`,
   `README.md`'s "Supported agents" section).
3. Copies every `skills/*/SKILL.md` into the user's global skill directory (prefers
   `~/.agents/skills`, falls back to `~/.claude/skills`) — this is what makes `/codex-send` and
   `/agy-send` available as Claude Code skills (`bin/agent-bridge.js:273-281`).
4. Starts the dashboard and turns on autostart (macOS `launchd`; elsewhere a plain background
   `up`) (`bin/agent-bridge.js:282-287`).

`npx skills add . -g --agent '*' -y` is a lighter-weight alternative that installs only the
skills (via the standard Skills CLI), without linking the `agent-bridge` binary, starting the
dashboard, or registering `codex-direct` (`README.md`'s "Skill-only install" section) — full
setup still needs `npm link && agent-bridge install`.

## The skills (`skills/codex-send/`, `skills/agy-send/`)

Each is a single `SKILL.md` with YAML frontmatter (`name`, `description` — the description is
what Claude Code matches against trigger phrases like "/codex-send", "have codex do X"). Both
skills tell Claude (as planner) the same four-step protocol:

1. Write a precise task spec before dispatching — vague prompts make the executor wander and
   burn tokens.
2. Dispatch via `agent-bridge run --agent <codex|antigravity> ...` in the background
   (`run_in_background: true`), optionally with `--session` to continue a conversation.
3. Track progress by reading `agent-bridge status/result/list` or the raw ledger files
   directly; if `status.md`'s `needs_input` is set, the executor is blocked and waiting on an
   answer from Claude.
4. **Never merge/commit the executor's work automatically** — inspect the diff first, then
   follow the project's own review rules.

`skills/codex-send/SKILL.md` additionally documents the `--transport exec` fallback and warns
against calling the `codex-direct` MCP escape hatch unless explicitly asked to bypass the
bridge ledger.

## The Claude Code plugin manifests (`.claude-plugin/`)

- **`plugin.json`** — the plugin's own manifest: name, description, version, author, homepage/
  repository (`teamnebula-ai/agent-bridge`). Validated locally with `claude plugin validate
  .claude-plugin/plugin.json` (`README.md`'s "Local development" section).
- **`marketplace.json`** — the Team Nebula marketplace listing that points `/plugin marketplace
  add teamnebula-ai/agent-bridge` at this same repo/plugin, so `/plugin install agent-bridge`
  can pull it from GitHub.

Together these are what make the one-line end-user install work: `/plugin marketplace add
teamnebula-ai/agent-bridge` then `/plugin install agent-bridge` — no `npm install`, no global
setup, and the bundled CLI ships inside the plugin (`README.md`'s "Install" section). The
plugin does **not** install prerequisites itself: Node ≥ 18, Python 3, and the `codex`/`agy`
CLIs on PATH are expected to already be present; `agent-bridge doctor` reports what's missing.
