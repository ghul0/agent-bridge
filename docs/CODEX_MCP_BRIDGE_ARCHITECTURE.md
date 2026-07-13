# Codex MCP Bridge Architecture

## Purpose

`agent-bridge` is the control plane between a planning agent and executor agents.

The target workflow is:

1. Claude Code reads the repo, plans the work, and writes a precise handoff.
2. Claude Code calls `agent-bridge`, not Codex directly.
3. `agent-bridge` creates a durable task ledger.
4. `agent-bridge` sends the handoff to Codex through `codex mcp-server`.
5. Codex executes the task in the target repo.
6. `agent-bridge` records status, result, events, telemetry, and session metadata.
7. Claude Code reads the task ledger to report progress, answer blockers, and review the result.

The key design rule: Codex MCP is an execution transport inside `agent-bridge`.
It is not the primary user-facing interface. Direct Claude Code -> Codex MCP bypasses the bridge's
audit trail and should only exist as an explicit escape hatch.

## Goals

- Let Claude Code repeatedly delegate implementation tasks to Codex.
- Use Codex's native MCP server for multi-turn sessions through `codex` and `codex-reply`.
- Preserve the existing filesystem work-log contract for every turn.
- Keep `codex exec --json` available as a fallback transport.
- Keep Antigravity support independent of Codex MCP.
- Support cold one-shot tasks, named multi-turn sessions, and warm Codex MCP daemon use.
- Make every task inspectable without a live socket or daemon.
- Avoid automatic commits, pushes, merges, or deploys unless explicitly requested.

## Non-Goals

- Do not replace Claude Code's planning role.
- Do not make Claude Code call Codex MCP directly as the default workflow.
- Do not build a full Codex UI client around `codex app-server` yet.
- Do not make the bridge a generic MCP gateway for every tool.
- Do not store secrets, private client data, or tenant memory in the task ledger.

## External Codex Interfaces

Codex exposes several relevant local interfaces:

### `codex mcp-server`

This is the primary interface for the bridge.

It is a stdio MCP server with two tools:

- `codex`: start a Codex thread.
- `codex-reply`: continue an existing Codex thread by `threadId`.

The `codex` tool accepts:

- `prompt`: initial user prompt.
- `cwd`: working directory.
- `sandbox`: `read-only`, `workspace-write`, or `danger-full-access`.
- `approval-policy`: `untrusted`, `on-failure`, `on-request`, or `never`.
- `model`: optional model override.
- `config`: Codex config overrides.
- `base-instructions`: optional replacement instructions.
- `developer-instructions`: optional injected developer instructions.
- `compact-prompt`: optional compaction prompt.

The `codex-reply` tool accepts:

- `threadId`: Codex thread id.
- `conversationId`: deprecated alias for `threadId`.
- `prompt`: next user prompt.

The bridge should store `threadId` as the session id.

### `codex exec --json`

This remains the fallback transport.

It is useful when:

- MCP initialization fails.
- The user explicitly asks for non-warm/non-session one-shot execution.
- CI or scripts want a single process with JSONL stdout.
- We need the current rich `--json` event stream behavior before MCP event parity is complete.

### `codex app-server`

This is not part of the first implementation.

It is for richer app-style integrations with a JSON-RPC app protocol, remote UI clients, approvals,
history, and streamed state. It may become useful later for a custom bridge UI, but it is heavier
than needed for Claude Code -> agent-bridge -> Codex handoff.

## High-Level Architecture

```text
Claude Code
  |
  | /codex-send or shell command
  v
agent-bridge CLI
  |
  | creates task folder
  v
filesystem task ledger
  |
  | chooses transport
  v
Codex transport adapter
  |
  | MCP JSON-RPC over stdio
  v
codex mcp-server
  |
  | runs Codex agent
  v
target repository
```

Claude Code observes the task through files, not through the MCP socket.

## Component Responsibilities

### `bin/agent-bridge.js`

The CLI owns user-facing commands and option parsing.

Responsibilities:

- Parse `run`, `warm`, `sessions`, `status`, `result`, `watch`, `doctor`, and service commands.
- Accept `--agent codex|antigravity`.
- Accept `--transport mcp|exec` for Codex.
- Default Codex transport to `mcp`.
- Validate sandbox values.
- Dispatch work to `lib/dispatch.js`.
- Start/stop the warm daemon.
- Install skills.
- Optionally register a direct Codex MCP under an explicit escape-hatch name.

### `lib/dispatch.js`

The dispatcher owns the canonical task lifecycle.

Responsibilities:

- Create a task folder through `fslog.newTask`.
- Resolve named sessions.
- Resolve isolated worktrees.
- Build the current-turn handoff prompt.
- Run the selected agent transport.
- Stream or collect events into `events.jsonl`.
- Backstop `status.md`.
- Write `result.md` if the executor did not.
- Harvest telemetry.
- Save session metadata.
- Capture patch diffs for isolated runs.
- Optionally create PRs only when `--pr` is explicitly passed.

The dispatcher is the right place to normalize different transports. `codex exec` and Codex MCP
must both produce the same task ledger shape.

### `lib/agents.js`

The agent registry owns agent-specific command construction and event parsing for process-based
agents.

Responsibilities:

- Keep the Codex `exec` adapter.
- Keep the Antigravity adapter.
- Keep the common work-log preamble builder.
- Keep process stdout event parsers where relevant.

Codex MCP should not be forced into the same process-spawn shape if that makes the implementation
awkward. It can be a transport branch in `dispatch.js`, while `agents.js` remains the process-agent
registry.

### `lib/codex-mcp.js`

The Codex MCP client owns the stdio JSON-RPC connection to `codex mcp-server`.

Responsibilities:

- Spawn `codex mcp-server`.
- Send `initialize`.
- Send `notifications/initialized`.
- Call `tools/call` with `codex` or `codex-reply`.
- Return `{ threadId, text, events, raw }`.
- Collect `codex/event` notifications while a tool call is active.
- Reject pending calls if the MCP process exits.
- Serialize calls unless and until Codex events are strongly correlated by thread id.
- Close the child process cleanly.

The client should not know about task folders, PRs, worktrees, or dashboard telemetry.

### `lib/warm-daemon.js`

The warm daemon owns a long-lived Codex MCP server process.

Responsibilities:

- Keep one MCP server process warm.
- Route named sessions to `threadId`s.
- Accept localhost HTTP requests from the CLI.
- Run calls serially through the MCP client.
- Restore known sessions from `sessions.json` at startup.
- Record every warm turn into the normal task ledger, not only `warm/<session>/turn-N.json`.
- Return task id, thread id, text, and event count to the CLI.

Warm daemon is an optimization, not a separate product path. It must preserve the same observability
and file contract as cold runs.

### `lib/fslog.js`

The filesystem ledger owns durable task and session state.

Responsibilities:

- Create task ids.
- Create task directories.
- Write `task.md`.
- Write and patch `status.md`.
- Write `result.md`.
- Resolve `latest`.
- Load/save `sessions.json`.
- List sessions and tasks.

### `lib/telemetry.js`

Telemetry owns normalized action extraction after a run.

Responsibilities:

- Parse Codex `events.jsonl` for command, file change, agent message, and token usage events.
- Parse Antigravity local trajectory stores.
- Write `telemetry.jsonl`.
- Write `telemetry.json`.
- Redact secrets.
- Optionally hash-chain events when verification is enabled.

MCP event harvesting should either reuse the existing Codex event parser or normalize MCP events into
the same JSONL format.

## Command Surface

### Canonical Claude Code Path

```bash
agent-bridge run --agent codex -C <repo> "<handoff>"
```

Default behavior:

- transport: `mcp`
- sandbox: `workspace-write`
- approval policy: `never`
- task ledger: enabled
- session: none unless `--session` is passed

### Explicit Transport Selection

```bash
agent-bridge run --agent codex --transport mcp -C <repo> "<handoff>"
agent-bridge run --agent codex --transport exec -C <repo> "<handoff>"
```

`mcp`:

- Use `codex mcp-server`.
- Preferred default.

`exec`:

- Use `codex exec --json`.
- Existing behavior.

### Named Sessions

```bash
agent-bridge run --agent codex --session feature-x -C <repo> "<handoff>"
agent-bridge sessions
```

Session behavior:

- First turn calls MCP `codex`.
- Later turns call MCP `codex-reply`.
- `sessions.json` stores the `threadId`.
- The current prompt always includes the current task's `status.md` and `result.md` paths.
- The session can reuse an isolated worktree if the first turn used `--isolate`.

### Warm Sessions

```bash
agent-bridge warm up
agent-bridge warm send --session feature-x -C <repo> "<handoff>"
agent-bridge warm status
agent-bridge warm down
```

Warm behavior:

- Starts a background daemon with a long-lived `codex mcp-server`.
- Uses the same MCP tools as cold `run --transport mcp`.
- Creates normal task folders for every turn.
- Restores sessions from `sessions.json`.
- Returns task id and result text.

### Direct Codex MCP Escape Hatch

If installed at all, direct Claude Code -> Codex MCP should be named something like:

```text
codex-direct
```

It should be documented as bypassing:

- `task.md`
- `status.md`
- `result.md`
- bridge telemetry
- dashboard task history
- worktree isolation helpers

The default `/codex-send` skill must not use direct MCP.

## Task Ledger Contract

Every delegated task must create:

```text
~/.agent-bridge/tasks/<id>/
  task.md
  status.md
  result.md
  events.jsonl
  telemetry.jsonl
  telemetry.json
  artifacts/
```

Optional files:

```text
  patch.diff
```

### `task.md`

Initial frontmatter:

```yaml
---
task: <id>
agent: codex
transport: mcp
cwd: <target repo or worktree>
sandbox: workspace-write
created: <iso timestamp>
status: dispatched
session: <optional session name>
threadId: <optional after known>
---
<original handoff prompt>
```

Terminal frontmatter should include:

```yaml
status: done|error
finished: <iso timestamp>
usage: <json or blank>
worktree: <optional>
branch: <optional>
diffstat: <optional>
pr: <optional>
```

### `status.md`

Initial status:

```yaml
---
task: <id>
agent: codex
status: queued
progress: 0
updated: <iso timestamp>
summary: queued
needs_input:
---
_Waiting for the agent to start._
```

Codex should be instructed to overwrite this file while working.

The dispatcher must backstop it:

- `working` when the first event/output arrives.
- `done` when the run exits successfully and Codex did not write terminal status.
- `error` when the transport or run fails.
- `blocked` only when Codex explicitly reports a blocker through the file or final result.

### `result.md`

Codex may write this file directly.

If it does not, the dispatcher writes:

- MCP result content, or
- final Codex agent message, or
- raw output, or
- error text.

### `events.jsonl`

For `exec`, this is Codex `--json` stdout.

For MCP, this should contain one JSON object per MCP event/result:

```json
{"type":"mcp.tool.call","tool":"codex","threadId":null,"timestamp":"..."}
{"type":"codex/event","event":{...}}
{"type":"mcp.tool.result","tool":"codex","threadId":"...","content":"...","timestamp":"..."}
```

The event shape should be stable enough for telemetry to parse and tolerant enough to keep raw MCP
payloads when Codex changes event details.

## Prompt Contract

Every Codex turn must include the current task protocol, even in an existing session.

This is required because a Codex thread may remember an old task folder. Reusing the old preamble on
`codex-reply` can cause stale status writes.

The prompt should include:

- The role: Codex is executor, Claude planned the task.
- The target cwd.
- The current task id.
- The absolute `status.md` path.
- The absolute `result.md` path.
- The instruction to update `status.md` before starting and every meaningful step.
- The instruction to write final output to `result.md`.
- The instruction to ask for help through `needs_input` if blocked.
- The instruction to append action lines to `activity.jsonl`.
- The actual handoff.
- Acceptance criteria.

For resumed sessions, the prompt can be shorter than the first-turn preamble, but it must still carry
the current task paths and terminal file-writing instructions.

## Session Model

Sessions are stored in:

```text
~/.agent-bridge/sessions.json
```

Shape:

```json
{
  "feature-x": {
    "agent": "codex",
    "transport": "mcp",
    "mode": "cold|warm",
    "sessionId": "<codex threadId>",
    "threadId": "<codex threadId>",
    "cwd": "<original repo>",
    "worktree": "<optional isolated worktree>",
    "branch": "<optional branch>",
    "updated": "<iso timestamp>",
    "turns": 3,
    "lastTask": "<task id>"
  }
}
```

Rules:

- `sessionId` remains the generic bridge field.
- `threadId` can also be saved for clarity.
- A session belongs to exactly one agent.
- A session belongs to exactly one transport unless explicitly migrated.
- If a session has a worktree, later turns use that worktree.
- If a session's repo/worktree no longer exists, dispatch fails clearly.
- Warm daemon startup should preload this file into its session map.

## Transport Model

Codex has two bridge transports:

```text
codex:mcp
codex:exec
```

They share:

- task creation
- status backstop
- result writing
- session saving
- telemetry harvest
- isolation
- PR handling

They differ only in how the Codex turn is executed.

### MCP Transport Flow

New session:

```text
dispatch
  -> fslog.newTask
  -> build current task prompt
  -> create or reuse MCP client
  -> call tool "codex" with {prompt, cwd, sandbox, approval-policy}
  -> write events.jsonl
  -> write result.md
  -> save threadId in sessions.json
  -> harvest telemetry
```

Existing session:

```text
dispatch
  -> fslog.newTask
  -> build current task prompt
  -> load threadId from sessions.json
  -> call tool "codex-reply" with {threadId, prompt}
  -> write events.jsonl
  -> write result.md
  -> refresh sessions.json
  -> harvest telemetry
```

### Exec Transport Flow

New session:

```text
dispatch
  -> fslog.newTask
  -> build current task prompt
  -> spawn codex exec --json --sandbox <sandbox> -C <cwd> --add-dir <taskdir>
  -> parse stdout JSONL
  -> extract thread_id if sessioned
  -> write result/status/telemetry
```

Existing session:

```text
dispatch
  -> fslog.newTask
  -> build current task prompt
  -> spawn codex exec resume --json <thread_id>
  -> parse stdout JSONL
  -> write result/status/telemetry
```

Exec remains useful but should no longer be the default for `/codex-send`.

## Isolation and PR Behavior

Isolation behavior is transport-independent.

```bash
agent-bridge run --agent codex --isolate -C <repo> "<task>"
```

Rules:

- Requires a git repo.
- Creates worktree under `~/.agent-bridge/worktrees/<task-id>`.
- Creates branch `agent-bridge/<task-id>`.
- Runs Codex in the worktree.
- Captures staged diff to `patch.diff`.
- Leaves the worktree for review.

`--pr` implies `--isolate`.

Rules:

- Only commit/push/open PR after the Codex run succeeds.
- Never self-merge.
- Reuse an existing PR if the session branch already has one.
- Include telemetry summary in the PR body.

## Status and Blocker Loop

The bridge should support this loop:

1. Claude sends task.
2. Codex writes progress to `status.md`.
3. Claude reads `agent-bridge status <id>`.
4. If `needs_input` is set, Claude answers by sending a follow-up through the same session.
5. Codex continues in the same thread/worktree.

Important detail: a blocker answer is a new task turn with a new task id. It should still use the
same Codex `threadId`, but a new `status.md` and `result.md`.

## Telemetry

MCP transport should preserve at least:

- tool start/end
- Codex event notifications
- final text
- thread id
- token usage if present in events
- commands if present in events
- file changes if present in events

If MCP event payloads differ from `codex exec --json`, telemetry should normalize them in a separate
adapter instead of assuming identical event shapes.

Telemetry must redact:

- OpenAI keys
- GitHub tokens
- GitLab tokens
- Slack tokens
- AWS access keys
- bearer tokens
- fields named like password, secret, token, or api key

## Security and Tenancy

Security defaults:

- Default sandbox: `workspace-write`.
- Default approval policy for Codex MCP: `never`.
- Never use `danger-full-access` unless explicitly requested.
- Never commit/push/open PR without explicit flags.
- Never write secrets into prompts, memory, docs, or task ledgers.
- Task ledgers live in `~/.agent-bridge`; they may contain repo paths and summaries, so treat them
  as local operational records.
- Do not mix client tenant context across tasks.

Direct MCP registration must be opt-in or clearly labeled as bypassing bridge controls.

## Error Handling

### MCP Initialization Failure

If transport is `mcp`:

- Mark task `error`.
- Write stderr/error into `result.md`.
- Do not silently run `exec`.

### MCP Tool Failure

- Mark task `error`.
- Write MCP error into `result.md`.
- Preserve raw events in `events.jsonl`.
- Keep session metadata unchanged unless a new `threadId` is known.

### MCP Process Exit During Turn

- Reject pending request.
- Mark task `error`.
- Write partial events and error result.

### Missing Session Thread

- If `--session` exists but no `threadId` is stored, start a new thread and save it.
- If the stored `threadId` is rejected by Codex, mark error and ask the user whether to restart the
  session. Do not silently create a new thread for a named existing session.

### Stale Worktree

- If a session points to a missing worktree, fail clearly.
- Do not fall back to the original repo silently, because that can mix file state.

## Dashboard Behavior

The dashboard should continue reading `~/.agent-bridge/tasks`.

For MCP tasks, it should display:

- agent: `codex`
- transport: `mcp`
- session name if present
- thread id prefix
- status/progress
- result
- telemetry rollup

Warm turns should appear as normal tasks.

## Installation Behavior

`agent-bridge install` should:

- install `/codex-send` and `/agy-send` skills.
- start dashboard services.
- register bridge skills.
- avoid registering direct `codex` MCP as the primary path.

If direct Codex MCP is installed, it should be:

```bash
claude mcp add codex-direct --scope user -- codex mcp-server
```

and the installer should print that it bypasses the bridge ledger.

## Skill Behavior

`/codex-send` should tell Claude Code:

1. Plan first.
2. Write a precise handoff.
3. Call `agent-bridge run --agent codex`.
4. Use `--session <name>` for iterative work.
5. Use `--transport exec` only when explicitly needed.
6. Track progress with `agent-bridge status`.
7. Answer blockers with a same-session follow-up.
8. Review diffs before committing.

The skill should not instruct Claude Code to call the `codex` MCP directly.

## Implementation Phases

### Phase 1: Cold MCP Transport

- Add `--transport`.
- Default Codex to `mcp`.
- Implement MCP execution inside normal `dispatch`.
- Always create task ledger.
- Save `threadId` for sessions.
- Write MCP events to `events.jsonl`.
- Keep `exec` fallback manually available.

### Phase 2: Warm Daemon Ledger Parity

- Make `warm send` create normal task folders.
- Restore sessions from `sessions.json`.
- Return task ids.
- Share MCP event writing and result handling with cold MCP.

### Phase 3: Telemetry Parity

- Normalize MCP events into `telemetry.jsonl`.
- Ensure dashboard displays commands/file changes/token usage for MCP tasks.

### Phase 4: Direct MCP Cleanup

- Rename direct MCP registration to `codex-direct`.
- Make direct registration opt-in or clearly documented as an escape hatch.
- Update README and skills.

## Acceptance Criteria

1. `agent-bridge run --agent codex -C <repo> "..."` uses Codex MCP by default.
2. Every MCP run creates a normal task folder under `~/.agent-bridge/tasks`.
3. `status.md` is available immediately and reaches `done` or `error`.
4. `result.md` contains the Codex final text.
5. `events.jsonl` contains MCP call/result records and raw Codex notifications.
6. `--session <name>` stores and reuses the Codex `threadId`.
7. Resumed sessions receive the current task's `status.md` and `result.md` paths.
8. `--transport exec` preserves the old `codex exec --json` behavior.
9. `warm send` either creates normal task folders or is clearly marked experimental until it does.
10. README and `/codex-send` describe Claude Code -> agent-bridge -> Codex MCP as the canonical path.
