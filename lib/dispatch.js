"use strict";
/**
 * dispatch — run one task on one agent, wiring the filesystem work-log protocol.
 *
 * Claude (planner) calls this. It: creates the task dir, spawns the agent with the
 * work-log preamble, streams the agent's event JSONL to events.jsonl, and BACKSTOPS
 * status.md (queued→working→done/error) so Claude has a status even if the agent
 * forgets to write one. The agent's own status.md/result.md remain authoritative.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const fslog = require("./fslog");
const { AGENTS, preamble } = require("./agents");
const telemetry = require("./telemetry");

function dispatch({ agent, prompt, cwd, sandbox }) {
  const spec = AGENTS[agent];
  if (!spec) throw new Error(`unknown agent '${agent}'. Known: ${Object.keys(AGENTS).join(", ")}`);
  cwd = cwd || process.cwd();
  sandbox = sandbox || "workspace-write";
  if (!fs.existsSync(cwd)) throw new Error(`working dir does not exist: ${cwd}`);

  const { id, dir } = fslog.newTask({ agent, cwd, sandbox, prompt });
  const statusFile = fslog.statusPath(dir);
  const full = preamble({ id, agent, statusFile, selfStatus: spec.selfStatus !== false }) + prompt;
  const { args, opts } = spec.build({ prompt: full, cwd, sandbox, taskdir: dir });

  console.log(`▶ ${agent} ← task ${id}`);
  console.log(`  workspace: ${cwd}  (sandbox ${sandbox})`);
  console.log(`  status file Claude reads:  ${statusFile}`);

  const events = fs.createWriteStream(path.join(dir, "events.jsonl"), { flags: "a" });
  const startTs = Date.now();
  const child = spawn(spec.bin, args, opts);
  let buf = "", started = false, finalText = "", lastUsage = null, errText = "", raw = "";

  function onLine(line) {
    if (!line.trim()) return;
    events.write(line + "\n");
    raw += line + "\n"; // full stdout — the result for plain-text agents (no structured final)
    const p = spec.parse(line);
    if (!p) return;
    if (!started) { started = true; fslog.patchStatus(dir, { status: "working", summary: "agent running" }); }
    if (p.usage) lastUsage = p.usage;
    if (p.final) finalText = p.final;
  }

  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on("data", (d) => { errText += d.toString(); });

  return new Promise((resolve) => {
    let finished = false;
    let eventsClosed = false;
    function closeEvents(cb) {
      if (eventsClosed) return cb();
      eventsClosed = true;
      events.end(cb);
    }
    function finish(code) {
      if (finished) return;
      finished = true;
      // Did the agent leave a terminal status? If not, backstop it.
      const cur = fslog.readStatus(dir).fields;
      const terminal = ["done", "error", "blocked"].includes(cur.status);
      if (code === 0 && !terminal) fslog.patchStatus(dir, { status: "done", progress: 100, summary: "completed" });
      if (code !== 0) fslog.patchStatus(dir, { status: "error", summary: `exit ${code}` });
      // Write result.md if the agent didn't.
      const resPath = path.join(dir, "result.md");
      if (!fs.existsSync(resPath)) fslog.writeResult(dir, finalText || raw.trim() || errText || "(no output)");
      // Stamp task.md terminal status + usage.
      const t = fslog.parse(fs.readFileSync(path.join(dir, "task.md"), "utf8"));
      fs.writeFileSync(path.join(dir, "task.md"), fslog.serialize(
        { ...t.fields, status: code === 0 ? "done" : "error", finished: fslog.iso(),
          usage: lastUsage ? JSON.stringify(lastUsage) : "" }, t.body));
      try { telemetry.harvest(agent, dir, cwd, startTs); }
      catch (e) { console.error(`telemetry harvest failed: ${e.message || e}`); }
      resolve({ id, dir, code, finalText: finalText || raw.trim() || errText, usage: lastUsage });
    }

    child.on("close", (code) => {
      if (buf.trim()) onLine(buf);
      closeEvents(() => finish(code));
    });
    child.on("error", (e) => {
      errText = e.message;
      fslog.patchStatus(dir, { status: "error", summary: e.message });
      closeEvents(() => finish(127));
    });
  });
}

module.exports = { dispatch };
