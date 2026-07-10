# agent-bridge telemetry — capturing "what each agent did", verifiably

Goal: for every delegated task, record a normalized, tamper-evident ledger of the agent's
actions (tool calls, file edits, commands, tokens) to a file we can verify — regardless of
which agent ran. Two layers per agent: a **native tap** (authoritative) and a **self-journal**
(cross-check). Reference design = the Knostic OpenClaw telemetry plugin.

## Normalized schema — `~/.agent-bridge/tasks/<id>/telemetry.jsonl`
Append-only, one JSON event per line (adopted from Knostic):
```json
{"seq":1,"ts":1752000000000,"type":"tool.start","tool":"write_file","params":{"path":"fizzbuzz.py"},"agent":"antigravity"}
{"seq":2,"ts":1752000000120,"type":"tool.end","tool":"write_file","status":"ok","durationMs":120,"agent":"antigravity"}
{"seq":3,"ts":1752000000500,"type":"llm.usage","tokensIn":91766,"tokensOut":1241,"agent":"codex"}
```
- `type` ∈ `tool.start | tool.end | command | file.edit | llm.usage | message.in | message.out | agent.start | agent.end`.
- **Redaction (before write):** mask secrets with regex — `sk-…`, `ghp_/gho_…`, `glpat-…`, Slack `xox[baprs]-…`, AWS keys, bearer tokens, `api_key|password|secret|token` values → `[REDACTED]`.
- **Tamper-evidence (opt-in `--verify`):** each line adds `prevHash` + `hash` (SHA256 of the
  event + prevHash) → a hash chain verifiable by replay. Genesis prevHash = 64 zeros.
- Also write a rollup `telemetry.json`: `{agent, actions, tools:{write_file:3,command:2}, filesTouched:[…], tokensIn, tokensOut, durationSec, verified:true}` — the dashboard reads this.

## Per-agent native tap (`lib/telemetry.js` → `harvest(agent, taskdir, cwd, startTs)`)

### codex  (rich — already streaming `--json`)
Parse the task's `events.jsonl` (already captured): map `item.completed` where
`item.type==="command_execution"` → `command`, `"file_change"` → `file.edit`,
`"agent_message"` → `message.out`; `turn.completed.usage` → `llm.usage`. (Optionally also read
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for the same run by `cwd`+timestamp.)
Codex also supports native OTEL (`[otel]` in `~/.codex/config.toml`: `codex.tool.call`,
`codex.tool.call.duration_ms`, `codex.turn.e2e_duration_ms`) — out of scope for v1.

### antigravity  (trajectory SQLite — VERIFIED extractable)
agy has NO working OTEL (upstream issue #366) and its stdout is plain text, so harvest its
own trajectory store:
1. Read `~/.gemini/antigravity-cli/history.jsonl` — lines are
   `{display, timestamp, workspace, conversationId}`. Find the entry whose `workspace` == the
   task `cwd` and `timestamp` >= dispatch start (newest match) → `conversationId`.
2. Open `~/.gemini/antigravity-cli/conversations/<conversationId>.db` (SQLite). Table `steps`
   has `idx, step_type (int), status (int), step_payload (blob), task_details (blob), metadata (blob)`.
3. The blobs are protobuf; extract printable runs (`/[\x20-\x7e]{4,}/`) per step and pull:
   tool markers (`write_to_file`, `toolAction`, `command`), file `file://` paths, and the
   `{"CodeContent":…,"Description":…}` payloads. (Proven: this recovers the tool, path, content,
   and reasoning from a real run.) Map each step → a `tool.start`/`tool.end`/`file.edit` event.
   `status` int → ok/error. Full proto decode is a later enhancement; string extraction is
   enough for actions + files + summaries.

### gemini  (when authed)
Prefer its native file exporter: set `telemetry.outfile=<taskdir>/gemini-telemetry.log` (or
`GEMINI_TELEMETRY_ENABLED=1 GEMINI_TELEMETRY_TARGET=local GEMINI_TELEMETRY_OUTFILE=…`) in the
agent env, then parse `gemini_cli.tool_call` / `api_response` (token usage) events. Fallback:
parse the `-o stream-json` events already in `events.jsonl`.

### claude (optional, for Claude-as-executor or supervising session)
A `PostToolUse` hook (`settings.json`) receives `{session_id, tool_name, tool_input,
tool_response, cwd, duration_ms}` on stdin → append one normalized line. Highest fidelity.

## Self-journal (agent-agnostic cross-check)
Add to the dispatch preamble (all agents): *"Append one line to `activity.jsonl` in your
working directory for each action you take, as `{"ts":…,"action":"…","target":"…"}`."* After
the run, the harvester reads `<cwd>/activity.jsonl` (if present), normalizes it, and **diffs
against the native tap** — a large discrepancy (agent under-reported) is flagged in
`telemetry.json.selfReportGap`. This is the "instruct them to record it too, so we can verify."

## Wiring
- `lib/dispatch.js`: after the agent exits, call `telemetry.harvest(agent, dir, cwd, startTs)`
  → writes `telemetry.jsonl` + `telemetry.json` in the task dir.
- `lib/dashboard.js`: `/api/sessions` reads `telemetry.json` per task so `commands`,
  `fileChanges`, and per-tool counts are populated for ALL agents (fixes agy showing 0).
  Detail drawer shows the action ledger + a "verified ✓ / gap" badge.

## Acceptance
1. After an Antigravity run, `telemetry.jsonl` lists its `write_file`/`command` actions with
   file paths, derived from the trajectory DB (not stdout).
2. After a Codex run, the same schema is produced from `--json`.
3. Redaction masks a planted `sk-test123…` secret in params.
4. `telemetry.json` rollup drives non-zero `commands`/`fileChanges` in the dashboard for agy.
5. `--verify` hash chain validates via replay; tampering with a line breaks it.

## Sources
Knostic `openclaw-telemetry` (schema, hash-chain, redaction, rate-limit); Claude Code hooks
(`PostToolUse` payload) + OTEL; Codex `--json`/rollouts/`[otel]`; Hermes ATOF/ShareGPT
trajectories; Gemini `telemetry.outfile`; Antigravity trajectory SQLite (local recon) + OTEL
gap issue #366. Full research notes: this repo's git history / the research agent transcript.
