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
const { createCodexServer } = require("./codex-mcp");

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
  // If a PR already exists for this branch (session's later turns), the push updated it.
  const existing = (spawnSync("gh", ["pr", "list", "--head", branch, "--json", "url", "-q", ".[0].url"],
    { cwd: worktree, encoding: "utf8" }).stdout || "").trim();
  if (existing) return { url: existing, updated: true };
  // PR body carries the telemetry attestation of what the agent actually did.
  let tel = {};
  try { tel = JSON.parse(fs.readFileSync(path.join(dir, "telemetry.json"), "utf8")); } catch { /* ok */ }
  const body = `Automated change by **${agent}** via agent-bridge.\n\n` +
    `**Task:** ${firstLine(prompt)}\n\n` +
    `**Telemetry** (native tap${tel.verified ? ", hash-chain verified ✓" : ""}): ` +
    `actions ${tel.actions ?? "?"} · commands ${tel.commands ?? "?"} · fileChanges ${tel.fileChanges ?? "?"}\n\n` +
    `Task record: \`~/.agent-bridge/tasks/${path.basename(dir)}/\``;
  const pr = spawnSync("gh", ["pr", "create", "--title", `[${agent}] ${firstLine(prompt)}`, "--body", body],
    { cwd: worktree, encoding: "utf8" });
  if (pr.status !== 0) return { error: `gh pr create failed: ${(pr.stderr || "").trim()}` };
  return { url: (pr.stdout || "").trim().split("\n").pop() };
}

function effectiveTransport(agent, transport) {
  if (agent === "codex") return transport || "mcp";
  if (transport) throw new Error(`--transport is only supported for codex`);
  return "cli";
}

function sessionIdFor(sess) {
  return sess && (sess.threadId || sess.sessionId);
}

function terminalStatus(code, dir) {
  const cur = fslog.readStatus(dir).fields;
  if (cur.status === "blocked") return "blocked";
  return code === 0 ? "done" : "error";
}

function captureWorktree(worktree, dir) {
  if (!worktree) return "";
  spawnSync("git", ["-C", worktree, "add", "-A"], { stdio: "ignore" });
  const d = spawnSync("git", ["-C", worktree, "diff", "--cached"], { encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "patch.diff"), d.stdout || "");
  return (spawnSync("git", ["-C", worktree, "diff", "--cached", "--stat"],
    { encoding: "utf8" }).stdout || "").trim().split("\n").pop() || "";
}

function finishTask({ agent, transport, prompt, dir, runCwd, startTs, code, finalText, raw,
  errText, lastUsage, worktree, branch, pr, session, sess, spec, threadId, cwd }) {
  const status = terminalStatus(code, dir);
  const currentStatus = fslog.readStatus(dir);
  const cur = currentStatus.fields;
  const placeholderBody = /Waiting for the agent to start/i.test(currentStatus.body || "");
  const terminal = ["done", "error", "blocked"].includes(cur.status);
  if (code === 0 && (!terminal || placeholderBody)) {
    fslog.writeStatus(dir, { ...cur, status: "done", progress: 100,
      updated: fslog.iso(), summary: "completed" }, "## Done\n- completed\n");
  }
  if (code !== 0 && (!terminal || placeholderBody)) {
    fslog.writeStatus(dir, { ...cur, status: "error",
      updated: fslog.iso(), summary: errText || `exit ${code}` }, `## Error\n- ${errText || `exit ${code}`}\n`);
  }

  const resPath = path.join(dir, "result.md");
  const output = finalText || raw.trim() || errText || "(no output)";
  if (!fs.existsSync(resPath)) fslog.writeResult(dir, output);

  const diffStat = captureWorktree(worktree, dir);
  const t = fslog.parse(fs.readFileSync(path.join(dir, "task.md"), "utf8"));
  fs.writeFileSync(path.join(dir, "task.md"), fslog.serialize(
    { ...t.fields, status, finished: fslog.iso(),
      usage: lastUsage ? JSON.stringify(lastUsage) : "",
      transport,
      ...(threadId ? { threadId } : {}),
      ...(worktree ? { worktree, branch, diffstat: diffStat } : {}) }, t.body));

  try { telemetry.harvest(agent, dir, runCwd, startTs); }
  catch (e) { console.error(`telemetry harvest failed: ${e.message || e}`); }

  if (session) {
    const sid = threadId
      || (spec.extractSessionId ? spec.extractSessionId({ dir, cwd: runCwd, startMs: startTs }) : null)
      || sessionIdFor(sess)
      || null;
    fslog.saveSession(session, { agent, transport, sessionId: sid, threadId: sid,
      cwd: sess && sess.cwd || cwd || runCwd,
      worktree, branch, updated: fslog.iso(), turns: ((sess && sess.turns) || 0) + 1,
      lastTask: path.basename(dir) });
  }

  let prResult = null;
  if (pr && worktree && code === 0) {
    prResult = openPullRequest(worktree, branch, agent, prompt, dir);
    const t2 = fslog.parse(fs.readFileSync(path.join(dir, "task.md"), "utf8"));
    fs.writeFileSync(path.join(dir, "task.md"), fslog.serialize(
      { ...t2.fields, pr: prResult.url || `(${prResult.skipped || prResult.error || "n/a"})` }, t2.body));
  }
  return { prResult, output };
}

function runMcpTransport({ spec, prompt, full, cwd, runCwd, sandbox, dir, id, transport,
  worktree, branch, pr, session, sess, statusFile, model }) {
  console.log(`▶ codex ← task ${id}${sessionIdFor(sess) ? ` · resume session '${session}' (${sessionIdFor(sess).slice(0, 8)})` : session ? ` · new session '${session}'` : ""}`);
  console.log(`  workspace: ${runCwd}  (sandbox ${sandbox}${worktree ? `, isolated on branch ${branch}` : ""}, transport mcp)`);
  console.log(`  status file Claude reads:  ${statusFile}`);

  const events = fs.createWriteStream(path.join(dir, "events.jsonl"), { flags: "a" });
  const startTs = Date.now();
  let started = false, finalText = "", lastUsage = null, errText = "", raw = "", threadId = sessionIdFor(sess);

  function writeEvent(obj) {
    events.write(JSON.stringify({ timestamp: fslog.iso(), ...obj }) + "\n");
  }
  function markWorking() {
    if (!started) {
      started = true;
      fslog.patchStatus(dir, { status: "working", summary: "codex mcp running" });
    }
  }
  function observeCodexEvent(ev) {
    markWorking();
    writeEvent({ type: "codex/event", event: ev });
    raw += JSON.stringify(ev) + "\n";
    const p = spec.parse(JSON.stringify(ev));
    if (p && p.usage) lastUsage = p.usage;
    if (p && p.final) finalText = p.final;
  }

  return new Promise(async (resolve) => {
    let server = null;
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
      closeEvents(() => {
        const result = finishTask({ agent: "codex", transport, prompt, dir, runCwd, startTs,
          code, finalText, raw, errText, lastUsage, worktree, branch, pr, session, sess, spec,
          threadId, cwd });
        resolve({ id, dir, code, finalText: result.output, usage: lastUsage, pr: result.prResult });
      });
    }

    try {
      server = createCodexServer();
      await server.initialize();
      const tool = threadId ? "codex-reply" : "codex";
      writeEvent({ type: "mcp.tool.call", tool, threadId: threadId || null });
      const res = threadId
        ? await server.reply(threadId, full, { onEvent: observeCodexEvent })
        : await server.start({ prompt: full, cwd: runCwd || cwd, sandbox,
          "approval-policy": "never", ...(model ? { model } : {}) }, { onEvent: observeCodexEvent });
      threadId = res.threadId || threadId;
      finalText = res.text || finalText;
      writeEvent({ type: "mcp.tool.result", tool, threadId: threadId || null,
        content: res.text || "", raw: res.raw });
      finish(0);
    } catch (e) {
      errText = e.message || String(e);
      writeEvent({ type: "mcp.error", error: errText, threadId: threadId || null });
      fslog.patchStatus(dir, { status: "error", summary: errText.slice(0, 100) });
      finish(1);
    } finally {
      if (server) server.close();
    }
  });
}

function runProcessTransport({ agent, spec, prompt, full, runCwd, sandbox, taskdir, dir, id,
  transport, worktree, branch, pr, session, sess, statusFile, cwd, model, agentProfile }) {
  const resuming = !!(sess && sess.sessionId && spec.resumeBuild);
  const { args, opts } = resuming
    ? spec.resumeBuild({ sessionId: sess.sessionId, prompt: full, cwd: runCwd, sandbox, taskdir, model, agentProfile })
    : spec.build({ prompt: full, cwd: runCwd, sandbox, taskdir, model, agentProfile });

  console.log(`▶ ${agent} ← task ${id}${resuming ? ` · resume session '${session}' (${sess.sessionId.slice(0, 8)})` : session ? ` · new session '${session}'` : ""}`);
  console.log(`  workspace: ${runCwd}  (sandbox ${sandbox}${worktree ? `, isolated on branch ${branch}` : ""}${transport ? `, transport ${transport}` : ""})`);
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
      closeEvents(() => {
        const result = finishTask({ agent, transport, prompt, dir, runCwd, startTs, code,
          finalText, raw, errText, lastUsage, worktree, branch, pr, session, sess, spec,
          threadId: null, cwd });
        resolve({ id, dir, code, finalText: result.output, usage: lastUsage, pr: result.prResult });
      });
    }

    child.on("close", (code) => {
      if (buf.trim()) onLine(buf);
      finish(code);
    });
    child.on("error", (e) => {
      errText = e.message;
      fslog.patchStatus(dir, { status: "error", summary: e.message });
      finish(127);
    });
  });
}

function dispatch({ agent, prompt, cwd, sandbox, isolate, pr, session, transport, model, agentProfile }) {
  const spec = AGENTS[agent];
  if (!spec) throw new Error(`unknown agent '${agent}'. Known: ${Object.keys(AGENTS).join(", ")}`);
  cwd = cwd || process.cwd();
  sandbox = sandbox || "workspace-write";
  transport = effectiveTransport(agent, transport);
  if (!fs.existsSync(cwd)) throw new Error(`working dir does not exist: ${cwd}`);

  // Session reuse: resume the agent's native conversation + its worktree for continuity.
  const sess = session ? fslog.getSession(session) : null;
  if (sess && sess.agent && sess.agent !== agent)
    throw new Error(`session '${session}' belongs to '${sess.agent}', not '${agent}'`);
  if (sess && agent === "codex" && sess.transport && sess.transport !== transport)
    throw new Error(`session '${session}' uses codex transport '${sess.transport}', not '${transport}'`);

  const { id, dir } = fslog.newTask({ agent, cwd, sandbox, prompt, transport, session,
    threadId: sessionIdFor(sess) });

  // Isolation: since --dangerously-* removes the OS sandbox as a boundary, give each
  // run its own git worktree + branch so concurrent agents on one repo never collide.
  let runCwd = cwd, worktree = null, branch = null;
  if (sess && sessionIdFor(sess)) {
    runCwd = sess.worktree || sess.cwd || cwd;   // reuse the session's file state
    worktree = sess.worktree || null;
    branch = sess.branch || null;
  } else if (isolate) {
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

  if (agent === "codex" && transport === "mcp") {
    return runMcpTransport({ spec, prompt, full, cwd, runCwd, sandbox, dir, id, transport,
      worktree, branch, pr, session, sess, statusFile, model });
  }
  return runProcessTransport({ agent, spec, prompt, full, runCwd, sandbox, taskdir: dir,
    dir, id, transport, worktree, branch, pr, session, sess, statusFile, cwd, model, agentProfile });
}

module.exports = { dispatch };
