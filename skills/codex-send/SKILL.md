---
name: codex-send
description: Delegate an execution task to the OpenAI Codex CLI while Claude plans. Use when the user says "/codex-send <task>", "have codex do X", "send this to codex", or "delegate to codex". Runs agent-bridge (filesystem work-log + telemetry dashboard); Claude tracks Codex's progress via a rewritable status.md and answers questions Codex sends back.
---

# codex-send — Claude plans, Codex executes

You are the **planner**; Codex is the **executor**. Delegate through `agent-bridge`, which
calls Codex through `codex mcp-server` by default and records progress as plain Markdown you
can read anytime. Do not call the direct `codex-direct` MCP unless the user explicitly asks to
bypass the bridge ledger.

1. **Write a precise task.** Do the thinking first — read the code, decide the approach,
   state the files to touch and acceptance criteria. A sharp spec keeps Codex cheap and
   accurate; a vague one makes it wander and burn tokens.
2. **Dispatch** (long-running; use `run_in_background: true`):
   ```bash
   agent-bridge run --agent codex -C <repo> "<precise task>"     # default: Codex MCP
   agent-bridge run --agent codex --session <name> -C <repo> "<next turn>"
   agent-bridge run --agent codex --transport exec -C <repo> "<task>"  # fallback
   ```
   Requires Codex auth (`codex login`) — check `agent-bridge doctor`.

   **Codex profiles:** To run with a specific Codex profile (defined in `~/.codex/<name>.config.toml`),
   use the `--agent-profile` flag together with `--transport exec`:
   ```bash
   agent-bridge run --agent codex --agent-profile code-reviewer --transport exec -s read-only -C <repo> "<task>"
   ```
   This passes `-p <name>` to `codex exec`, which layers the profile config on top of the base
   config. **`--agent-profile` requires `--transport exec`** — `codex mcp-server` (the default
   transport) has no profile parameter, so the bridge rejects `--agent-profile` without
   `--transport exec` instead of silently ignoring it.

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
