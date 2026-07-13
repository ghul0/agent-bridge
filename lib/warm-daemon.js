"use strict";
/**
 * warm-daemon — a persistent process that holds ONE warm `codex mcp-server` and routes
 * named sessions to it as threads. The orchestrator sends prompts over localhost HTTP and
 * gets responses back; context stays resident (no per-turn CLI spawn).
 *
 *   POST /send   {session, prompt, cwd?, sandbox?}  → {session, threadId, text, events}
 *   GET  /status                                    → {serverUp, sessions:[...]}
 *
 * One codex mcp-server hosts N sessions (each a threadId). Codex-only (Antigravity has no
 * local server today). Started via `agent-bridge warm up`; talked to via `warm send`.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createCodexServer } = require("./codex-mcp");
const fslog = require("./fslog");
const telemetry = require("./telemetry");
const { AGENTS, preamble } = require("./agents");

const PORT = Number(process.env.WARM_PORT || 7677);
let server = null;                    // the warm codex mcp client
const sessions = new Map();           // name → { threadId, cwd }

function savedSession(name) {
  const saved = fslog.getSession(name);
  if (!saved || saved.agent !== "codex") return null;
  const threadId = saved.threadId || saved.sessionId;
  if (!threadId) return null;
  return { threadId, cwd: saved.worktree || saved.cwd || process.cwd() };
}

function hydrateSessions() {
  for (const saved of fslog.listSessions()) {
    if (saved.agent !== "codex") continue;
    const threadId = saved.threadId || saved.sessionId;
    if (!threadId || sessions.has(saved.name)) continue;
    sessions.set(saved.name, { threadId, cwd: saved.worktree || saved.cwd || process.cwd() });
  }
}

function closeStream(stream) {
  return new Promise((resolve) => stream.end(resolve));
}

async function ensureServer() {
  if (server) return server;
  server = createCodexServer();
  await server.initialize();
  return server;
}

async function handleSend({ session, prompt, cwd, sandbox, model }) {
  if (!session || !prompt) throw new Error("session and prompt are required");
  let entry = sessions.get(session) || savedSession(session);
  if (entry) sessions.set(session, entry);

  const task = fslog.newTask({ agent: "codex", transport: "mcp", session,
    cwd: entry && entry.cwd || cwd || process.cwd(), sandbox: sandbox || "workspace-write",
    prompt, threadId: entry && entry.threadId });
  const statusFile = fslog.statusPath(task.dir);
  const full = preamble({ id: task.id, agent: "codex", statusFile }) + prompt;
  const events = fs.createWriteStream(path.join(task.dir, "events.jsonl"), { flags: "a" });
  const startTs = Date.now();
  let started = false, finalText = "", lastUsage = null, raw = "", errText = "";

  function writeEvent(obj) {
    events.write(JSON.stringify({ timestamp: fslog.iso(), ...obj }) + "\n");
  }
  function observe(ev) {
    raw += JSON.stringify(ev) + "\n";
    writeEvent({ type: "codex/event", event: ev });
    if (!started) {
      started = true;
      fslog.patchStatus(task.dir, { status: "working", summary: "codex mcp warm running" });
    }
    const p = AGENTS.codex.parse(JSON.stringify(ev));
    if (p && p.usage) lastUsage = p.usage;
    if (p && p.final) finalText = p.final;
  }

  let res;
  try {
    const s = await ensureServer();
    let tool;
    if (!entry || !entry.threadId) {
      tool = "codex";
      writeEvent({ type: "mcp.tool.call", tool, threadId: null });
      res = await s.start({ prompt: full, cwd: cwd || process.cwd(),
        sandbox: sandbox || "workspace-write", "approval-policy": "never",
        ...(model ? { model } : {}) }, { onEvent: observe });
      entry = { threadId: res.threadId, cwd: cwd || process.cwd() };
      sessions.set(session, entry);
    } else {
      tool = "codex-reply";
      writeEvent({ type: "mcp.tool.call", tool, threadId: entry.threadId });
      res = await s.reply(entry.threadId, full, { onEvent: observe });   // reply inherits the thread's cwd
    }
    finalText = res.text || finalText;
    writeEvent({ type: "mcp.tool.result", tool,
      threadId: res.threadId || entry.threadId, content: res.text || "", raw: res.raw });
    if (res.threadId) entry.threadId = res.threadId;
    const cur = fslog.readStatus(task.dir).fields;
    fslog.writeStatus(task.dir, { ...cur, status: "done", progress: 100,
      updated: fslog.iso(), summary: "completed" }, "## Done\n- completed\n");
  } catch (e) {
    errText = e.message || String(e);
    writeEvent({ type: "mcp.error", error: errText, threadId: entry && entry.threadId || null });
    const cur = fslog.readStatus(task.dir).fields;
    fslog.writeStatus(task.dir, { ...cur, status: "error",
      updated: fslog.iso(), summary: errText.slice(0, 100) }, `## Error\n- ${errText}\n`);
    await closeStream(events);
    fslog.writeResult(task.dir, errText);
    const parsed = fslog.parse(fs.readFileSync(path.join(task.dir, "task.md"), "utf8"));
    fs.writeFileSync(path.join(task.dir, "task.md"), fslog.serialize(
      { ...parsed.fields, status: "error", finished: fslog.iso(),
        usage: lastUsage ? JSON.stringify(lastUsage) : "" }, parsed.body));
    throw e;
  }
  await closeStream(events);
  if (!fs.existsSync(path.join(task.dir, "result.md"))) fslog.writeResult(task.dir, finalText || raw.trim() || errText);

  const parsed = fslog.parse(fs.readFileSync(path.join(task.dir, "task.md"), "utf8"));
  fs.writeFileSync(path.join(task.dir, "task.md"), fslog.serialize(
    { ...parsed.fields, status: "done", finished: fslog.iso(),
      usage: lastUsage ? JSON.stringify(lastUsage) : "", threadId: entry.threadId }, parsed.body));
  try { telemetry.harvest("codex", task.dir, entry.cwd, startTs); }
  catch (e) { console.error(`telemetry harvest failed: ${e.message || e}`); }

  // Record: a lightweight turn log + the session mapping (so `sessions`/dashboard see it).
  const dir = path.join(fslog.ROOT, "warm", session);
  fs.mkdirSync(dir, { recursive: true });
  const prev = fslog.getSession(session) || {};
  const turns = (prev.turns || 0) + 1;
  fs.writeFileSync(path.join(dir, `turn-${turns}.json`),
    JSON.stringify({ prompt, threadId: entry.threadId, text: res.text, events: res.events }, null, 2));
  fslog.saveSession(session, { agent: "codex", transport: "mcp", mode: "warm",
    sessionId: entry.threadId, threadId: entry.threadId, cwd: entry.cwd,
    updated: fslog.iso(), turns, lastTask: task.id });
  return { session, task: task.id, threadId: entry.threadId, text: res.text, events: res.events.length };
}

function serve() {
  http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        try {
          const out = await handleSend(JSON.parse(body || "{}"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message || String(e) }));
        }
      });
      return;
    }
    if (req.url === "/status") {
      hydrateSessions();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ serverUp: !!server, port: PORT,
        sessions: [...sessions.entries()].map(([name, e]) => ({ name, ...e })) }));
      return;
    }
    res.writeHead(404); res.end();
  }).listen(PORT, "127.0.0.1", () => console.log(`warm daemon on http://localhost:${PORT}`));
}

if (require.main === module) serve();
module.exports = { serve, handleSend };
