---
name: codex-send
description: Delegate an execution task to the OpenAI Codex CLI while Claude plans. Use when Ian says "/codex-send <task>", "have codex do X", "send this to codex", or "delegate to codex". Runs agent-bridge (filesystem work-log + telemetry dashboard); Claude tracks Codex's progress via a rewritable status.md and answers questions Codex sends back.
---

# codex-send — Claude plans, Codex executes

You are the **planner**; Codex is the **executor**. Delegate through `agent-bridge`, which
drives Codex and records progress as plain Markdown you can read anytime.

1. **Write a precise task.** Do the thinking first — read the code, decide the approach,
   state the files to touch and acceptance criteria. A sharp spec keeps Codex cheap and
   accurate; a vague one makes it wander and burn tokens.
2. **Dispatch** (long-running; use `run_in_background: true`):
   ```bash
   agent-bridge run --agent codex -C <repo> "<precise task>"     # -s read-only for inspection
   ```
   Requires Codex auth (`codex login`) — check `agent-bridge doctor`.
3. **Track progress via the work-log:**
   ```bash
   agent-bridge status <id>      # the rewritable status.md (status/progress/summary)
   agent-bridge result <id>      # final output
   agent-bridge list             # all tasks + live status
   ```
   Or read `~/.agent-bridge/tasks/<id>/{status.md,result.md,task.md}` directly. **If
   `needs_input` is set, Codex is blocked and asking you** — answer it (your job as
   planner), then re-dispatch with the answer.
4. **Review before keeping.** Never merge/commit Codex's work automatically — inspect
   `git -C <repo> diff` first, then follow the project's review rules.

Watch usage across agents in the dashboard: `agent-bridge open`.
