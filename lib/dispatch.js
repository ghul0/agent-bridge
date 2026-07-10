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
const { spawn, spawnSync } = require("child_process");
const fslog = require("./fslog");
const { AGENTS, preamble } = require("./agents");
const telemetry = require("./telemetry");

function isGitRepo(dir) {
  return spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"],
    { stdio: "ignore" }).status === 0;
}

function firstLine(s) { return String(s || "").split("\n")[0].slice(0, 72); }

function openPullRequest(worktree, branch, agent, prompt, dir) {
  const at = (a) => spawnSync("git", ["-C", worktree, ...a], { encoding: "utf8" });
  if (at(["remote", "get-url", "origin"]).status !== 0) return { skipped: "no git remote 'origin'" };
  if (spawnSync("gh", ["--version"], { stdio: "ignore" }).status !== 0) return { skipped: "gh CLI not found" };
  // Drop the bridge's own artifact so the PR only contains the deliverable.
  fs.rmSync(path.join(worktree, "activity.jsonl"), { force: true });
  at(["add", "-A"]);
  if (at(["diff", "--cached", "--quiet"]).status === 0) return { skipped: "no changes to commit" };
  const msg = `${agent}: ${firstLine(prompt)}`;
  const c = at(["commit", "-m", msg]);
  if (c.status !== 0) return { error: `commit failed: ${(c.stderr || "").trim()}` };
  const p = at(["push", "-u", "origin", branch]);
  if (p.status !== 0) return { error: `push failed: ${(p.stderr || "").trim()}` };
  // PR body carries the telemetry attestation of what the agent actually did.
  let tel = {};
  try { tel = JSON.parse(fs.readFileSync(path.join(dir, "telemetry.json"), "utf8")); } catch { /* ok */ }
  const body = `Automated change by **${agent}** via [agent-bridge](https://github.com/iankiku/agent-bridge).\n\n` +
    `**Task:** ${firstLine(prompt)}\n\n` +
    `**Telemetry** (native tap${tel.verified ? ", hash-chain verified ✓" : ""}): ` +
    `actions ${tel.actions ?? "?"} · commands ${tel.commands ?? "?"} · fileChanges ${tel.fileChanges ?? "?"}\n\n` +
    `Task record: \`~/.agent-bridge/tasks/${path.basename(dir)}/\``;
  const pr = spawnSync("gh", ["pr", "create", "--title", `[${agent}] ${firstLine(prompt)}`, "--body", body],
    { cwd: worktree, encoding: "utf8" });
  if (pr.status !== 0) return { error: `gh pr create failed: ${(pr.stderr || "").trim()}` };
  return { url: (pr.stdout || "").trim().split("\n").pop() };
}

function dispatch({ agent, prompt, cwd, sandbox, isolate, pr }) {
  const spec = AGENTS[agent];
  if (!spec) throw new Error(`unknown agent '${agent}'. Known: ${Object.keys(AGENTS).join(", ")}`);
  cwd = cwd || process.cwd();
  sandbox = sandbox || "workspace-write";
  if (!fs.existsSync(cwd)) throw new Error(`working dir does not exist: ${cwd}`);

  const { id, dir } = fslog.newTask({ agent, cwd, sandbox, prompt });

  // Isolation: since --dangerously-* removes the OS sandbox as a boundary, give each
  // run its own git worktree + branch so concurrent agents on one repo never collide.
  let runCwd = cwd, worktree = null, branch = null;
  if (isolate) {
    if (!isGitRepo(cwd)) throw new Error(`--isolate requires a git repo at ${cwd}`);
    branch = `agent-bridge/${id}`;
    worktree = path.join(fslog.ROOT, "worktrees", id);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    // git briefly locks .git during `worktree add`; retry on contention from concurrent runs.
    let r, tries = 0;
    do {
      r = spawnSync("git", ["-C", cwd, "worktree", "add", "-b", branch, worktree, "HEAD"], { encoding: "utf8" });
      if (r.status === 0) break;
      if (!/lock|index|another git process/i.test(r.stderr || "") || ++tries >= 5) {
        throw new Error(`git worktree add failed: ${(r.stderr || "").trim()}`);
      }
      spawnSync("sleep", ["0.3"]);
    } while (true);
    runCwd = worktree;
  }

  const statusFile = fslog.statusPath(dir);
  const full = preamble({ id, agent, statusFile, selfStatus: spec.selfStatus !== false }) + prompt;
  const { args, opts } = spec.build({ prompt: full, cwd: runCwd, sandbox, taskdir: dir });

  console.log(`▶ ${agent} ← task ${id}`);
  console.log(`  workspace: ${runCwd}  (sandbox ${sandbox}${worktree ? `, isolated on branch ${branch}` : ""})`);
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
      // Isolated run: capture the diff so you can review/merge, leave the worktree for inspection.
      let diffStat = "";
      if (worktree) {
        spawnSync("git", ["-C", worktree, "add", "-A"], { stdio: "ignore" });
        const d = spawnSync("git", ["-C", worktree, "diff", "--cached"], { encoding: "utf8" });
        fs.writeFileSync(path.join(dir, "patch.diff"), d.stdout || "");
        diffStat = (spawnSync("git", ["-C", worktree, "diff", "--cached", "--stat"],
          { encoding: "utf8" }).stdout || "").trim().split("\n").pop() || "";
      }
      // Stamp task.md terminal status + usage.
      const t = fslog.parse(fs.readFileSync(path.join(dir, "task.md"), "utf8"));
      fs.writeFileSync(path.join(dir, "task.md"), fslog.serialize(
        { ...t.fields, status: code === 0 ? "done" : "error", finished: fslog.iso(),
          usage: lastUsage ? JSON.stringify(lastUsage) : "",
          ...(worktree ? { worktree, branch, diffstat: diffStat } : {}) }, t.body));
      try { telemetry.harvest(agent, dir, runCwd, startTs); }
      catch (e) { console.error(`telemetry harvest failed: ${e.message || e}`); }
      // --pr: commit the isolated change, push the branch, open a PR (uniform across agents).
      let prResult = null;
      if (pr && worktree && code === 0) {
        prResult = openPullRequest(worktree, branch, agent, prompt, dir);
        const t2 = fslog.parse(fs.readFileSync(path.join(dir, "task.md"), "utf8"));
        fs.writeFileSync(path.join(dir, "task.md"), fslog.serialize(
          { ...t2.fields, pr: prResult.url || `(${prResult.skipped || prResult.error || "n/a"})` }, t2.body));
      }
      resolve({ id, dir, code, finalText: finalText || raw.trim() || errText, usage: lastUsage, pr: prResult });
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
