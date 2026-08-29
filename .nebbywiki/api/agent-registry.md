---
type: api
title: Agent registry contract
description: What an AGENTS entry in lib/agents.js must implement to plug a new executor CLI into agent-bridge.
tags: [api, agents, extensibility]
timestamp: 2026-08-29
---

# Agent registry contract

`lib/agents.js` exports `AGENTS`, a plain object keyed by agent name — `codex` and
`antigravity` today. Adding a new executor is "one registry entry," provided that executor has
some shell/file-tool access so it can write `status.md` (`lib/agents.js:1-8`). This page is the
contract each entry must satisfy; see [Architecture overview](../architecture/overview.md) for
how `lib/dispatch.js` calls into it.

## Required shape

```js
AGENTS[name] = {
  bin: "codex",                 // executable to spawn (also used by `doctor`/`has()`)
  authHint: "run: codex login", // shown nowhere critical, but documents the setup step
  selfStatus: true,             // optional, default true — see below

  build({ prompt, cwd, sandbox, taskdir, model }) {
    return { args: [...], opts: { stdio: [...], cwd?, ... } };
  },

  resumeBuild({ sessionId, prompt, cwd, sandbox, taskdir, model }) {
    // optional — only needed if the agent supports resuming a prior conversation
    return { args: [...], opts: {...} };
  },

  extractSessionId({ dir, cwd, startMs }) {
    // optional — how to recover a resumable session/thread id after a run
  },

  parse(line) {
    // required — parse one line of stdout/one event into {kind, text, usage?, final?}
    return { kind, text, usage: undefined, final: undefined };
  },
};
```

## Field-by-field, from the two real entries (`lib/agents.js:87-158`)

- **`bin`** — the executable name; `has(bin)` (`bin/agent-bridge.js:20-22`) checks it's on
  PATH for `doctor`.
- **`build({prompt, cwd, sandbox, taskdir, model})`** — returns `{args, opts}` for
  `child_process.spawn`. Must translate the bridge's abstract `sandbox` (`"read-only"` /
  `"workspace-write"`) into the agent's own flags — Codex maps it to `--sandbox read-only|
  workspace-write`; Antigravity maps it to `--mode plan` (read-only) vs.
  `--dangerously-skip-permissions` (write) since it has no built-in sandbox concept
  (`lib/agents.js:91-99`, `lib/agents.js:135-143`).
- **`resumeBuild({sessionId, prompt, cwd, sandbox, taskdir, model})`** — same shape as
  `build`, but for continuing a prior conversation. `lib/dispatch.js` only calls this when a
  named session has a `sessionId` (`resuming` check, `lib/dispatch.js:209-212`). Codex's
  version has quirks worth copying if you add a similar agent: `codex exec resume` inherits
  the session's original sandbox and takes no `-C`/`--sandbox`/`--add-dir`, so the working dir
  has to be set via the spawned process's `cwd` option instead, and options must precede the
  session id positional arg (`lib/agents.js:100-108`).
- **`extractSessionId({dir, cwd, startMs})`** — how to recover a durable session/thread id
  once a run finishes, for `--session` reuse next time. Codex parses `thread_id` out of the
  task's own `events.jsonl` (`codexThreadId()`, `lib/agents.js:16-24`); Antigravity has no
  such id in its stdout, so it matches the conversation `.db` file under
  `~/.gemini/antigravity-cli/conversations/` whose mtime falls in the run's time window
  (`agyConversationId()`, `lib/agents.js:27-39`). `lib/dispatch.js` prefers a `threadId`
  returned directly from the transport call before falling back to this
  (`sessionIdFor()`/`finishTask()`, `lib/dispatch.js:62-65`, `113-122`).
- **`parse(line)`** — called once per stdout line (process transport) or once per streamed
  event (Codex MCP transport). Must return `null`/falsy for lines to ignore, or
  `{kind, text, usage?, final?}`: `usage` becomes the task's token usage snapshot, `final`
  (when set) becomes the task's `result.md` content. Codex's parser distinguishes
  `item.completed` (→ `kind: item.type`, `final` only for `agent_message` items) from
  `turn.completed` (→ token usage) (`lib/agents.js:110-121`); Antigravity has no structured
  events, so every line is just accumulated as plain-text output (`lib/agents.js:154-156`).
- **`selfStatus`** (optional, default `true`) — set to `false` if the agent can't reliably
  write into a *second* directory (its own workspace is the only place it writes). This
  switches `preamble()` to a minimal instruction set and tells `lib/dispatch.js` to backstop
  `status.md` itself instead of trusting the agent to maintain it
  (`lib/agents.js:41-52`, `lib/agents.js:132-134`). Antigravity sets this because it writes
  into its `--add-dir` workspace, not the process cwd.

## `preamble({id, agent, statusFile, selfStatus})`

Generates the work-log instructions prepended to every prompt before it reaches the executor
(`lib/agents.js:44-84`). With `selfStatus: true` it hands the agent the full
frontmatter-rewrite protocol (`status`/`progress`/`updated`/`summary`/`needs_input`) plus the
instruction to append to `activity.jsonl` for the telemetry self-journal cross-check (see
[Telemetry and dashboard data flow](../architecture/telemetry-and-dashboard.md)). With
`selfStatus: false` it only asks for the `activity.jsonl` journal, since the dispatcher owns
`status.md` in that case.

## A removed entry, for reference

A `gemini` entry once lived in this registry (`build`: `gemini -p ... --approval-mode yolo -o
stream-json`; resume: `gemini --continue`) but was removed since the maintainer only uses
Codex + Antigravity; the comment at `lib/agents.js:124-126` preserves the shape to re-add it if
the Gemini CLI gets authenticated again.
