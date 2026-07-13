"use strict";
/**
 * agents — registry of executor CLIs the bridge can delegate to.
 *
 * Each agent knows how to: build its non-interactive command for a task, and parse
 * one line of its event stream into {kind, text, usage?} for telemetry. Adding a new
 * agent = one entry here (it must have a shell/file tools so it can write status.md).
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

function homePath(p) { return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p; }

// Codex: the session id is the thread_id from its --json event stream.
function codexThreadId(dir) {
  try {
    for (const line of fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n")) {
      const m = /"thread_id":"([^"]+)"/.exec(line);
      if (m) return m[1];
    }
  } catch { /* none */ }
  return null;
}

// Antigravity: the session id is the conversation .db touched during the run (by mtime).
function agyConversationId(startMs) {
  const dir = homePath("~/.gemini/antigravity-cli/conversations");
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".db")) continue;
      let st; try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
      if (st.mtimeMs < startMs - 2000) continue;
      if (!best || st.mtimeMs > best.m) best = { id: f.replace(/\.db$/, ""), m: st.mtimeMs };
    }
  } catch { /* none */ }
  return best && best.id;
}

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
    build({ prompt, cwd, sandbox, taskdir, model }) {
      const sb = sandbox === "read-only" ? "read-only" : "workspace-write";
      const m = model ? ["-m", model] : [];
      return {
        args: ["exec", ...m, "--json", "--sandbox", sb, "-C", cwd, "--skip-git-repo-check",
          "--add-dir", taskdir, prompt],
        opts: { stdio: ["ignore", "pipe", "pipe"] },
      };
    },
    resumeBuild({ sessionId, prompt, cwd, model }) {
      // `codex exec resume` inherits the session's sandbox; it takes no -C/--sandbox/--add-dir,
      // so set the working dir via the process cwd. Options must precede the SESSION_ID.
      const m = model ? ["-m", model] : [];
      return {
        args: ["exec", "resume", ...m, "--json", "--skip-git-repo-check", sessionId, prompt],
        opts: { cwd, stdio: ["ignore", "pipe", "pipe"] },
      };
    },
    extractSessionId({ dir }) { return codexThreadId(dir); },
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

  // gemini: removed from the default registry — Ian uses codex + antigravity.
  // The adapter lived here (build: `gemini -p ... --approval-mode yolo -o stream-json`,
  // resume: `gemini --continue`); re-add one entry if you ever authenticate the Gemini CLI.

  antigravity: {
    bin: "agy",
    authHint: "run `agy` once and sign in (Antigravity)",
    // agy writes files into its --add-dir workspace, NOT the process cwd, and it can't
    // reliably write status.md into a *second* dir — so we make the target repo the
    // workspace and let the dispatcher backstop the status (selfStatus:false).
    selfStatus: false,
    build({ prompt, cwd, sandbox, model }) {
      // --mode plan = read-only; otherwise auto-approve all tools to make edits.
      const mode = sandbox === "read-only" ? ["--mode", "plan"] : ["--dangerously-skip-permissions"];
      const m = model ? ["--model", model] : [];
      return {
        args: ["-p", prompt, ...m, ...mode, "--add-dir", cwd],
        opts: { cwd, stdio: ["ignore", "pipe", "pipe"] },
      };
    },
    resumeBuild({ sessionId, prompt, cwd, sandbox }) {
      const mode = sandbox === "read-only" ? ["--mode", "plan"] : ["--dangerously-skip-permissions"];
      return {
        args: ["--conversation", sessionId, "-p", prompt, ...mode, "--add-dir", cwd],
        opts: { cwd, stdio: ["ignore", "pipe", "pipe"] },
      };
    },
    extractSessionId({ startMs }) { return agyConversationId(startMs); },
    // agy print mode emits plain text (no JSON events); the dispatcher accumulates
    // stdout as the result.
    parse(line) {
      return { kind: "output", text: line.slice(0, 500) };
    },
  },
};

module.exports = { AGENTS, preamble };
