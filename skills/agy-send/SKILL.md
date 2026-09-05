---
name: agy-send
description: Delegate an execution task to the Antigravity CLI (agy) while Claude plans. Use when the user says "/agy-send <task>", "have agy/antigravity do X", "send this to antigravity", or "delegate to agy". Runs agent-bridge (filesystem work-log + telemetry dashboard); Claude tracks Antigravity's progress via a rewritable status.md and answers questions it sends back.
---

# agy-send — Claude plans, Antigravity (agy) executes

You are the **planner**; Antigravity (the `agy` CLI) is the **executor**. Delegate through
`agent-bridge`, which drives `agy` and records progress as plain Markdown you can read anytime.

1. **Write a precise task.** Do the thinking first — read the code, decide the approach,
   state the files to touch and acceptance criteria. A sharp spec keeps it cheap and accurate.
2. **Dispatch** (long-running; use `run_in_background: true`):
   ```bash
   agent-bridge run --agent antigravity -C <repo> "<precise task>"    # -s read-only for inspection
   ```
   Requires Antigravity signed in (`agy` once) — check `agent-bridge doctor`.

   **Agent profiles:** To run a specific AGY agent (defined in `~/.gemini/config/agents/<name>.md`),
   use the `--agent-profile` flag:
   ```bash
   agent-bridge run --agent antigravity --agent-profile code-reviewer -s read-only -C <repo> "<task>"
   ```
   This passes `--agent <name>` to `agy`, which loads the agent's system instructions and persona.

3. **Track progress via the work-log:**
   ```bash
   agent-bridge status <id>      # the rewritable status.md (status/progress/summary)
   agent-bridge result <id>      # final output
   agent-bridge list             # all tasks + live status
   ```
   Or read `~/.agent-bridge/tasks/<id>/{status.md,result.md,task.md}` directly. **If
   `needs_input` is set, the agent is blocked and asking you** — answer it (your job as
   planner), then re-dispatch with the answer.
4. **Review before keeping.** Never merge/commit its work automatically — inspect
   `git -C <repo> diff` first, then follow the project's review rules.

Watch usage across agents in the dashboard: `agent-bridge open`.
