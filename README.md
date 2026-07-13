# agent-bridge

**Claude plans. Agents execute.** Delegate coding tasks from [Claude Code](https://claude.ai/code)
to **[Codex](https://github.com/openai/codex)** or **Antigravity (`agy`)**
(extensible), and track their work through a **plain-Markdown filesystem work-log** that
Claude can read anytime.

Claude does the thinking — reads the code, designs the change, writes a precise spec —
then hands execution to an agent. The agent writes its progress to simple Markdown files
with rewritable frontmatter, so Claude always knows the status without any live channel.

## Why a filesystem, not a socket?

Every task is just a folder of Markdown. No daemon to keep running, nothing to reconnect
to — Claude reads files, the agent writes files.

```
~/.agent-bridge/tasks/<id>/
  task.md       ← the assignment Claude wrote      (frontmatter: agent, cwd, sandbox)
  status.md     ← REWRITABLE progress the agent updates at intervals
  result.md     ← the final output
  events.jsonl  ← raw agent event stream (telemetry)
  artifacts/    ← any files the agent produced
~/.agent-bridge/latest → tasks/<id>   (most recent)
```

**The contract** — every agent, whatever it is, overwrites `status.md` at intervals with:

```markdown
---
task: 20260709-0250-add-health-route
agent: codex
status: working          # working | blocked | done | error
progress: 60
updated: 2026-07-09T02:51:12Z
summary: wrote the route, adding a test
needs_input:             # if set, the agent is blocked and asking Claude
---
## Done
- added /health returning {status:'ok'}
## Next
- add a test and run it
```

Because the frontmatter is rewritten each update, one file always reflects the current
state. `needs_input` turns the same file into a back-channel: the agent asks, Claude reads
it and answers. Adding a new agent is one registry entry — it just has to write this file.

## How it works end-to-end

The canonical Codex flow is:

```text
Claude Code
  -> /codex-send skill
  -> agent-bridge run --agent codex
  -> task ledger under ~/.agent-bridge/tasks/<id>/
  -> Codex MCP transport (codex mcp-server)
  -> target repo
  -> result/status/events/telemetry back in the task ledger
  -> Claude Code reads the ledger and reports/reviews the work
```

`agent-bridge` is the control plane. Claude Code should call the bridge, not direct Codex MCP,
because the bridge creates the durable task record, writes status/result files, captures MCP
events, extracts telemetry, tracks sessions, and preserves the fallback `codex exec --json`
path.

For Codex tasks:

- default transport: `codex mcp-server`
- fallback transport: `codex exec --json` via `--transport exec`
- session continuity: `--session <name>` stores and reuses the Codex `threadId`
- status loop: Claude reads `status.md`; Codex can set `needs_input`; Claude replies with another same-session task
- safety: no commits, pushes, PRs, or deploys happen unless explicitly requested

Full architecture: [`docs/CODEX_MCP_BRIDGE_ARCHITECTURE.md`](docs/CODEX_MCP_BRIDGE_ARCHITECTURE.md).

## Install

`agent-bridge` is a Node CLI package. In development, run it directly from this checkout or
link this checkout globally. You do not need to publish to npm to use the local version.

From this repo:

```bash
cd /Users/raskin/moonshot/agent-bridge
node bin/agent-bridge.js doctor
node bin/agent-bridge.js install
```

To make the `agent-bridge` command point at this local checkout:

```bash
cd /Users/raskin/moonshot/agent-bridge
npm link
agent-bridge doctor
agent-bridge install
```

For a published package install:

```bash
npm install -g agent-bridge
agent-bridge install        # installs /codex-send + /agy-send and starts the dashboard
agent-bridge doctor         # checks agents + auth
```

Prerequisites: **Node ≥ 18**, **Python 3**, and at least one agent:
- **Codex** — `codex login` (ChatGPT or API key)
- **Antigravity** — run `agy` once and sign in

`agent-bridge install` refreshes the Claude Code skills (`/codex-send`, `/agy-send`), starts
the dashboard services, and may register `codex-direct` as an explicit direct-MCP escape
hatch. The normal path is still `/codex-send` calling `agent-bridge`.

## Use it

After `install`, just talk to Claude Code:

> **"/agy-send refactor the parser in this repo"**  ·  **"/codex-send add a /health route"**

Claude plans, delegates, and reads the work-log to report progress. Under the hood (the
CLI runs these for you):

```bash
agent-bridge run --agent codex -C ./myrepo "add a /health route and a test"
agent-bridge list                 # every task + live status
agent-bridge status latest        # the rewritable status.md
agent-bridge result latest        # final output
agent-bridge watch latest         # live-tail the status file
```

Sandboxes: `-s read-only` (inspection; plan-mode, no edits) · `-s workspace-write`
(default; edits the repo, auto-approved).

Codex uses `codex mcp-server` by default, while preserving the old `codex exec --json`
path as an explicit fallback:

```bash
agent-bridge run --agent codex --transport mcp  -C ./myrepo "task"        # default
agent-bridge run --agent codex --transport exec -C ./myrepo "task"        # fallback
agent-bridge run --agent codex --session api-refactor -C ./myrepo "turn"  # reuse threadId
```

Architecture details: [`docs/CODEX_MCP_BRIDGE_ARCHITECTURE.md`](docs/CODEX_MCP_BRIDGE_ARCHITECTURE.md).

## Verify Codex MCP

Run a read-only smoke test before trusting the setup. This spends one real Codex model turn,
but it avoids modifying the repo by using `/private/tmp` and a temporary bridge home:

```bash
mkdir -p /private/tmp/agent-bridge-codex-smoke
AGENT_BRIDGE_HOME=/private/tmp/agent-bridge-smoke \
  agent-bridge run --agent codex --transport mcp -s read-only \
  -C /private/tmp/agent-bridge-codex-smoke \
  "Smoke test for agent-bridge Codex MCP transport. Do not modify files. Reply with exactly: AGENT_BRIDGE_CODEX_MCP_SMOKE_OK"
```

Expected final output:

```text
AGENT_BRIDGE_CODEX_MCP_SMOKE_OK
```

Then inspect the task ledger:

```bash
AGENT_BRIDGE_HOME=/private/tmp/agent-bridge-smoke agent-bridge status latest
AGENT_BRIDGE_HOME=/private/tmp/agent-bridge-smoke agent-bridge result latest
```

Or inspect the temporary task directory directly:

```bash
find /private/tmp/agent-bridge-smoke/tasks -maxdepth 2 -type f | sort
```

You should see `task.md`, `status.md`, `result.md`, `events.jsonl`, `telemetry.jsonl`,
and `telemetry.json`.

## Dashboard

`agent-bridge install` **starts the dashboard automatically** and (on macOS) sets it to
run at login, so once installed it's always available at `http://localhost:7676`.

Manage it from the CLI:

```bash
agent-bridge open              # open it in your browser (starts it if needed)
agent-bridge up [--port n]     # start dashboard + OTEL as background services
agent-bridge down              # stop them
agent-bridge autostart on|off  # run automatically at login (macOS launchd)
agent-bridge service status    # is it running?
agent-bridge dashboard         # run in the foreground (for debugging)
```

It reads `~/.agent-bridge/tasks/` live on each request, so running tasks appear without a
rebuild. The page is self-contained (inline CSS/JS, no CDNs) and combines delegated-agent
task telemetry with Claude Code OTEL data from `~/.agent-bridge/relay.db`. Cost estimates
come from `lib/pricing.json`; edit that file if your model pricing differs.

## Token accounting (across agents)

Agent-side tokens are captured from their event streams. For Claude's own usage, start the
bundled OTLP receiver and enable Claude Code telemetry (self-contained, no external service):

```bash
agent-bridge otel
export CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp \
       OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
       OTEL_METRIC_EXPORT_INTERVAL=5000   # default is 60000 (60s) — too slow for a live view
agent-bridge tokens
```

Restart Claude Code after setting those so it picks them up. Claude's tokens/cost then
appear in `agent-bridge tokens` and the dashboard within a few seconds.

## Supported agents

| agent | bin | edit mode | read-only mode | MCP server |
|-------|-----|-----------|----------------|------------|
| codex | `codex` | `sandbox=workspace-write` | `sandbox=read-only` | yes, default transport |
| antigravity | `agy` | `--dangerously-skip-permissions` | `--mode plan` | no |

`agent-bridge install` may register `codex-direct` as a direct Claude MCP escape hatch. The
canonical workflow remains Claude Code -> `agent-bridge` -> Codex MCP, because direct MCP
bypasses the bridge's task ledger and dashboard.

Never merges or commits automatically — you review the diff first.

## License

MIT
