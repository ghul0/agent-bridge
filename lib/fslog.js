"use strict";
/**
 * fslog — the agent-bridge filesystem work-log protocol.
 *
 * Every delegated task is a directory of plain Markdown files that Claude can read
 * anytime. The contract every executor agent follows is `status.md`: a REWRITABLE
 * file the agent overwrites at intervals with fresh frontmatter (status/progress/
 * updated) so Claude always knows where things stand.
 *
 *   ~/.agent-bridge/tasks/<id>/
 *     task.md       assignment written by Claude (the planner)
 *     status.md     REWRITABLE progress, written by the agent at intervals
 *     result.md     final output
 *     events.jsonl  raw agent event stream (telemetry)
 *     artifacts/    any files the agent produces for Claude
 *   ~/.agent-bridge/latest -> tasks/<id>   (symlink to the most recent task)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p && p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const ROOT = expandHome(process.env.AGENT_BRIDGE_HOME) || path.join(os.homedir(), ".agent-bridge");
const TASKS = path.join(ROOT, "tasks");

function iso() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

function slug(s, n = 4) {
  return (s || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").split("-").filter(Boolean).slice(0, n).join("-") || "task";
}

function taskId(prompt) {
  const t = iso().replace(/[-:TZ]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  // 4-char random suffix so concurrent same-second, same-prompt dispatches never collide.
  return `${t}-${slug(prompt)}-${crypto.randomBytes(2).toString("hex")}`;
}

// ---- flat frontmatter (key: value) — sufficient and human-obvious ----
function serialize(fields, body = "") {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v == null ? "" : String(v)}`).join("\n");
  return `---\n${fm}\n---\n${body ? body.replace(/^\n+/, "") : ""}`;
}

function parse(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text || "");
  if (!m) return { fields: {}, body: text || "" };
  const fields = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fields, body: m[2] || "" };
}

// ---- task lifecycle ----
function newTask({ agent, cwd, sandbox, prompt, transport, session, threadId }) {
  fs.mkdirSync(TASKS, { recursive: true });
  const id = taskId(prompt);
  const dir = path.join(TASKS, id);
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  const fields = { task: id, agent, cwd, sandbox, created: iso(), status: "dispatched" };
  if (transport) fields.transport = transport;
  if (session) fields.session = session;
  if (threadId) fields.threadId = threadId;
  fs.writeFileSync(path.join(dir, "task.md"), serialize(
    fields,
    prompt.endsWith("\n") ? prompt : prompt + "\n"));
  // initial status (backstop; the agent will overwrite this as it works)
  writeStatus(dir, { task: id, agent, status: "queued", progress: 0,
    updated: iso(), summary: "queued", needs_input: "" }, "_Waiting for the agent to start…_\n");
  try { // convenience symlink
    const link = path.join(ROOT, "latest");
    if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(link, { force: true });
    fs.symlinkSync(dir, link);
  } catch { /* symlinks optional */ }
  return { id, dir };
}

function statusPath(dir) { return path.join(dir, "status.md"); }

function writeStatus(dir, fields, body) {
  fs.writeFileSync(statusPath(dir), serialize(fields, body));
}

function readStatus(dir) {
  try { return parse(fs.readFileSync(statusPath(dir), "utf8")); }
  catch { return { fields: {}, body: "" }; }
}

/** Merge partial frontmatter into status.md without losing the agent's body. */
function patchStatus(dir, partial) {
  const { fields, body } = readStatus(dir);
  writeStatus(dir, { ...fields, ...partial, updated: iso() }, body);
}

function writeResult(dir, text) {
  fs.writeFileSync(path.join(dir, "result.md"), (text || "").trim() + "\n");
}

function listTasks() {
  if (!fs.existsSync(TASKS)) return [];
  return fs.readdirSync(TASKS).sort().reverse().map((id) => {
    const dir = path.join(TASKS, id);
    return { id, dir, ...readStatus(dir).fields };
  });
}

function taskDir(id) {
  if (!id || id === "latest") {
    const l = listTasks();
    return l.length ? l[0].dir : null;
  }
  const d = path.join(TASKS, id);
  return fs.existsSync(d) ? d : null;
}

// ---- named sessions (reuse each agent's native conversation across dispatches) ----
const SESSIONS = path.join(ROOT, "sessions.json");

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS, "utf8")); } catch { return {}; }
}
function getSession(name) { return loadSessions()[name] || null; }
function saveSession(name, obj) {
  const all = loadSessions();
  all[name] = { ...(all[name] || {}), ...obj };
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(SESSIONS, JSON.stringify(all, null, 2));
  return all[name];
}
function listSessions() {
  const all = loadSessions();
  return Object.keys(all).map((name) => ({ name, ...all[name] }));
}

module.exports = { ROOT, TASKS, iso, taskId, serialize, parse, newTask, statusPath,
  writeStatus, readStatus, patchStatus, writeResult, listTasks, taskDir,
  loadSessions, getSession, saveSession, listSessions };
