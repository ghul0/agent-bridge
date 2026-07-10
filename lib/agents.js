"use strict";
/**
 * agents — registry of executor CLIs the bridge can delegate to.
 *
 * Each agent knows how to: build its non-interactive command for a task, and parse
 * one line of its event stream into {kind, text, usage?} for telemetry. Adding a new
 * agent = one entry here (it must have a shell/file tools so it can write status.md).
 */
const path = require("path");

/** The protocol every agent is told to follow — write status.md at intervals.
 * selfStatus:false agents (that can't reliably write to the task dir) get a minimal
 * preamble; the dispatcher backstops their status instead. */
function preamble({ id, agent, statusFile, selfStatus = true }) {
  if (!selfStatus) {
    return `You are "${agent}", an executor agent in agent-bridge. Claude planned this task
and will read your final output. Create/modify files in the current working directory only.
Append one line to activity.jsonl in your working directory for each action you take, as {"ts":...,"action":"...","target":"..."}.
Perform this task:

`;
  }
  return `You are "${agent}", an executor agent in agent-bridge. Claude planned this task
and is reading your progress from a file. Follow this protocol:

WORK-LOG PROTOCOL (important):
- Your status file is:  ${statusFile}
- BEFORE you start, and again after each meaningful step (or roughly every 30 seconds),
  OVERWRITE that file completely with this exact format:

---
task: ${id}
agent: ${agent}
status: working          # one of: working | blocked | done | error
progress: 50             # integer 0-100
updated: <current ISO-8601 UTC timestamp>
summary: <one short line on the current state>
needs_input:             # leave blank, OR put a question here if you are blocked and need Claude
---
## Done
- <what you have completed>
## Next
- <what you are about to do>

- When finished: set status: done, progress: 100, and write your final answer to result.md
  in the same folder.
- If you hit something you cannot resolve: set status: blocked and put a specific question
  in needs_input, then stop.
- Append one line to activity.jsonl in your working directory for each action you take, as {"ts":...,"action":"...","target":"..."}.

Now perform this task:

`;
}

/** Map the bridge's abstract sandbox to each agent's flags. */
const AGENTS = {
  codex: {
    bin: "codex",
    authHint: "run: codex login",
    build({ prompt, cwd, sandbox, taskdir }) {
      const sb = sandbox === "read-only" ? "read-only" : "workspace-write";
      return {
        args: ["exec", "--json", "--sandbox", sb, "-C", cwd, "--skip-git-repo-check",
          "--add-dir", taskdir, prompt],
        opts: { stdio: ["ignore", "pipe", "pipe"] },
      };
    },
    parse(line) {
      let ev; try { ev = JSON.parse(line); } catch { return null; }
      const t = ev.type || "";
      if (t === "item.completed") {
        const it = ev.item || {};
        const text = it.text || it.message || it.command || "";
        return { kind: it.type || "item", text: String(text).slice(0, 500),
          final: it.type === "agent_message" ? it.text : undefined };
      }
      if (t === "turn.completed") return { kind: "usage", text: "", usage: ev.usage };
      return { kind: t, text: "" };
    },
  },

  gemini: {
    bin: "gemini",
    authHint: "set GEMINI_API_KEY, or run: gemini (and pick an auth method)",
    build({ prompt, cwd, sandbox, taskdir }) {
      const mode = sandbox === "read-only" ? "plan" : "yolo";
      return {
        args: ["-p", prompt, "--approval-mode", mode, "-o", "stream-json",
          "--include-directories", taskdir],
        opts: { cwd, stdio: ["ignore", "pipe", "pipe"] },
      };
    },
    // Gemini stream-json is JSONL; be tolerant about field names.
    parse(line) {
      let ev; try { ev = JSON.parse(line); } catch { return null; }
      const t = ev.type || ev.kind || "event";
      const text = ev.text || ev.content || ev.delta || ev.message ||
        (ev.tool && ev.tool.name) || "";
      const usage = ev.usage || ev.usageMetadata || (ev.stats && ev.stats.tokens);
      const final = (t === "assistant" || t === "content" || t === "final") ? (ev.text || ev.content) : undefined;
      return { kind: t, text: String(text).slice(0, 500), usage, final };
    },
  },

  antigravity: {
    bin: "agy",
    authHint: "run `agy` once and sign in (Antigravity)",
    // agy writes files into its --add-dir workspace, NOT the process cwd, and it can't
    // reliably write status.md into a *second* dir — so we make the target repo the
    // workspace and let the dispatcher backstop the status (selfStatus:false).
    selfStatus: false,
    build({ prompt, cwd, sandbox }) {
      // --mode plan = read-only; otherwise auto-approve all tools to make edits.
      const mode = sandbox === "read-only" ? ["--mode", "plan"] : ["--dangerously-skip-permissions"];
      return {
        args: ["-p", prompt, ...mode, "--add-dir", cwd],
        opts: { cwd, stdio: ["ignore", "pipe", "pipe"] },
      };
    },
    // agy print mode emits plain text (no JSON events); the dispatcher accumulates
    // stdout as the result.
    parse(line) {
      return { kind: "output", text: line.slice(0, 500) };
    },
  },
};

module.exports = { AGENTS, preamble };
