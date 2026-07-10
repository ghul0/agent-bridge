# agent-bridge

**Claude plans. Agents execute.** Delegate coding tasks from [Claude Code](https://claude.ai/code)
to **[Codex](https://github.com/openai/codex)** or **[Gemini](https://github.com/google-gemini/gemini-cli)**
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
agent: gemini
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

## Install

```bash
npm install -g agent-bridge
agent-bridge install        # registers MCP(s) + installs the /codex-send + /agy-send skills globally
agent-bridge doctor         # checks agents + auth
```

Prerequisites: **Node ≥ 18**, **Python 3**, and at least one agent:
- **Codex** — `codex login` (ChatGPT or API key)
- **Gemini** — `GEMINI_API_KEY`, or run `gemini` once and pick an auth method

## Use it

After `install`, just talk to Claude Code:

> **"/agy-send refactor the parser in this repo"**  ·  **"/codex-send add a /health route"**

Claude plans, delegates, and reads the work-log to report progress. Under the hood (the
CLI runs these for you):

```bash
agent-bridge run --agent gemini -C ./myrepo "add a /health route and a test"
agent-bridge list                 # every task + live status
agent-bridge status latest        # the rewritable status.md
agent-bridge result latest        # final output
agent-bridge watch latest         # live-tail the status file
```

Sandboxes: `-s read-only` (inspection; plan-mode, no edits) · `-s workspace-write`
(default; edits the repo, auto-approved).

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
| codex | `codex` | `--sandbox workspace-write` | `--sandbox read-only` | ✅ `codex mcp-server` |
| gemini | `gemini` | `--approval-mode yolo` | `--approval-mode plan` | — |

Never merges or commits automatically — you review the diff first.

## License

MIT
