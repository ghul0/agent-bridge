#!/usr/bin/env node
/**
 * agent-bridge — Claude plans, agents execute. Delegate a task to Codex or Antigravity
 * (extensible), with a plain-Markdown filesystem work-log Claude reads anytime.
 */
"use strict";
const { spawnSync, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const fslog = require("../lib/fslog");
const { AGENTS } = require("../lib/agents");
const { dispatch } = require("../lib/dispatch");

const LIB = path.join(__dirname, "..", "lib");
const SKILLS = path.join(__dirname, "..", "skills");
const HOME = os.homedir();
const AGENT_NAMES = Object.keys(AGENTS);

function has(bin) {
  try { execFileSync("bash", ["-lc", `command -v ${bin}`], { stdio: "ignore" }); return true; } catch { return false; }
}
function expandHome(p) {
  if (p === "~") return HOME;
  if (p && p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}
function bridgeHome() {
  return expandHome(process.env.AGENT_BRIDGE_HOME) || path.join(HOME, ".agent-bridge");
}
function bridgeEnv() {
  return { ...process.env, RELAY_DB: process.env.RELAY_DB || path.join(bridgeHome(), "relay.db") };
}
function py(script, args) {
  const r = spawnSync("python3", [path.join(LIB, script), ...args], { stdio: "inherit", env: bridgeEnv() });
  process.exitCode = r.status || 0;
}

function usage() {
  console.log(`agent-bridge — Claude plans, agents execute (filesystem work-log)

Usage:
  agent-bridge run --agent <${AGENT_NAMES.join("|")}> "<task>"   Delegate a task
       [-C <dir>] [-s read-only|workspace-write] [--model <name>] [--transport mcp|exec] [--verify]
       [--isolate]  run in a private git worktree+branch (no collisions)
       [--pr]       --isolate, then commit + push + open a PR (needs gh + remote)
       [--session <name>]  reuse the agent's conversation + worktree across runs
  agent-bridge sessions             List reusable sessions
  agent-bridge warm up|status|down  Warm continuous Codex (persistent mcp-server)
  agent-bridge warm send --session <name> [-C dir] "prompt"
                                    Send to a warm session, get the response back
  agent-bridge list                 List tasks with their live status
  agent-bridge status [<id>|latest] Show a task's status.md (default: latest)
  agent-bridge result [<id>|latest] Show a task's result.md
  agent-bridge watch  [<id>|latest] Live-tail a task's status.md
  agent-bridge tokens               Cross-agent token report (needs OTEL for Claude)
  agent-bridge otel                 Start the Claude-token OTLP receiver
  agent-bridge dashboard [--port n] [--open]
                                    Run the dashboard in the foreground (debug)
  agent-bridge up [--port n] [--open]   Start dashboard + OTEL as background services
  agent-bridge open                 Open the dashboard in your browser (starts if needed)
  agent-bridge down                 Stop the background services
  agent-bridge autostart [on|off]   Run the dashboard automatically at login
  agent-bridge service status       Is the dashboard running?
  agent-bridge install              Install /codex-send /agy-send skills + start the dashboard
  agent-bridge doctor               Check agents + auth

Tasks live in ~/.agent-bridge/tasks/<id>/ as plain Markdown (task.md, status.md,
result.md). After 'install', just tell Claude Code: "/codex-send <task>" or "/agy-send <task>".`);
}

const SANDBOXES = ["read-only", "workspace-write"];
const CODEX_TRANSPORTS = ["mcp", "exec"];

function parseRun(argv) {
  const o = { agent: null, cwd: process.cwd(), sandbox: "workspace-write", transport: null,
    prompt: null, verify: false, isolate: false, pr: false, session: null, model: null, agentProfile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent" || a === "-a") o.agent = argv[++i];
    else if (a === "-C") o.cwd = path.resolve(argv[++i]);
    else if (a === "-s") o.sandbox = argv[++i];
    else if (a === "--model" || a === "-m") o.model = argv[++i];
    else if (a === "--transport") o.transport = argv[++i];
    else if (a === "--agent-profile") o.agentProfile = argv[++i];
    else if (a === "--verify") o.verify = true;
    else if (a === "--isolate") o.isolate = true;
    else if (a === "--pr") { o.pr = true; o.isolate = true; }
    else if (a === "--session") o.session = argv[++i];
    else o.prompt = o.prompt ? o.prompt + " " + a : a;
  }
  return o;
}

function cmdSessions() {
  const s = fslog.listSessions();
  if (!s.length) return console.log("(no sessions yet — start one with: run --session <name> ...)");
  console.log(`${"session".padEnd(16)} ${"agent".padEnd(11)} ${"turns".padStart(5)}  sessionId`);
  console.log("─".repeat(70));
  for (const x of s)
    console.log(`${x.name.padEnd(16)} ${(x.agent || "?").padEnd(11)} ${String(x.turns || 0).padStart(5)}  ${(x.sessionId || "-").slice(0, 20)}`);
}

async function cmdRun(argv) {
  const o = parseRun(argv);
  if (!o.agent) return console.error(`--agent required (one of: ${AGENT_NAMES.join(", ")})`) || process.exit(1);
  if (!o.prompt) return console.error(`no task given`) || process.exit(1);
  if (!AGENTS[o.agent]) return console.error(`unknown agent '${o.agent}'`) || process.exit(1);
  if (!SANDBOXES.includes(o.sandbox)) return console.error(`invalid -s '${o.sandbox}' (use: ${SANDBOXES.join(" | ")})`) || process.exit(1);
  if (o.transport && o.agent !== "codex") return console.error(`--transport is only supported for codex`) || process.exit(1);
  if (o.agent === "codex" && o.transport && !CODEX_TRANSPORTS.includes(o.transport))
    return console.error(`invalid --transport '${o.transport}' (use: ${CODEX_TRANSPORTS.join(" | ")})`) || process.exit(1);
  if (o.agent === "codex" && o.agentProfile && (o.transport || "mcp") !== "exec")
    return console.error(`--agent-profile with codex requires --transport exec (codex mcp-server has no profile param)`) || process.exit(1);
  if (o.verify) process.env.AGENT_BRIDGE_TELEMETRY_VERIFY = "1";
  let r;
  try { r = await dispatch(o); }
  catch (e) { console.error(`✗ dispatch failed: ${e.message || e}`); process.exit(1); }
  console.log(`── ${o.agent} finished (exit ${r.code}) ──`);
  const res = path.join(r.dir, "result.md");
  if (fs.existsSync(res)) process.stdout.write("\n" + fs.readFileSync(res, "utf8"));
  if (r.pr) console.log(r.pr.url ? `── PR opened: ${r.pr.url}` : `── PR skipped: ${r.pr.skipped || r.pr.error}`);
  console.log(`\n── files: ${r.dir}`);
  console.log(`   status:  agent-bridge status ${r.id}`);
  process.exit(r.code);
}

function cmdList() {
  const tasks = fslog.listTasks();
  if (!tasks.length) return console.log("(no tasks yet)");
  console.log(`${"status".padEnd(9)} ${"prog".padStart(4)}  ${"agent".padEnd(7)} id`);
  console.log("─".repeat(64));
  for (const t of tasks.slice(0, 30))
    console.log(`${(t.status || "?").padEnd(9)} ${String(t.progress || 0).padStart(3)}%  ${(t.agent || "?").padEnd(7)} ${t.id}`);
}

function showFile(argv, file) {
  const dir = fslog.taskDir(argv[0]);
  if (!dir) return console.error("no such task");
  const f = path.join(dir, file);
  if (!fs.existsSync(f)) return console.log(`(${file} not written yet)`);
  process.stdout.write(fs.readFileSync(f, "utf8"));
}

function cmdWatch(argv) {
  const dir = fslog.taskDir(argv[0]);
  if (!dir) return console.error("no such task");
  const f = path.join(dir, "status.md");
  let last = "";
  console.log(`watching ${f}  (ctrl-c to stop)\n`);
  setInterval(() => {
    try { const c = fs.readFileSync(f, "utf8"); if (c !== last) { last = c; console.clear(); process.stdout.write(c); } } catch {}
  }, 1000);
}

function parseDashboard(argv) {
  const o = { port: 7676, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") o.port = Number(argv[++i]);
    else if (a === "--open") o.open = true;
    else return null;
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) return null;
  return o;
}

function openUrl(url) {
  const bin = process.platform === "darwin" ? "open" : "xdg-open";
  spawnSync(bin, [url], { stdio: "ignore", detached: true });
}

async function cmdDashboard(argv) {
  const o = parseDashboard(argv);
  if (!o) return console.error("usage: agent-bridge dashboard [--port <n>] [--open]") || process.exit(1);
  process.env.RELAY_DB = bridgeEnv().RELAY_DB;
  const { startServer } = require("../lib/dashboard");
  try {
    const { url } = await startServer({ port: o.port });
    console.log(`agent-bridge dashboard listening at ${url}`);
    if (o.open) openUrl(url);
  } catch (e) {
    console.error(`dashboard failed: ${e.message || e}`);
    process.exit(1);
  }
}

const service = require("../lib/service");

async function cmdUp(argv) {
  const p = parseDashboard(argv);
  const r = await service.up({ port: p && p.port });
  for (const d of r.results)
    console.log(`  ${d.already ? "•" : "▶"} ${d.name}${d.already ? " already running" : " started"}${d.pid ? ` (pid ${d.pid})` : ""}`);
  console.log(`\n✅ dashboard running at ${r.url}   (agent-bridge open · agent-bridge down)`);
  if (p && p.open) openUrl(r.url);
}
function cmdDown() {
  const r = service.down();
  console.log(`stopped dashboard${r.dashboard ? ` (pid ${r.dashboard})` : ""} + otel${r.otel ? ` (pid ${r.otel})` : ""}`);
}
async function cmdOpen() {
  const r = await service.up();            // ensure it's running
  openUrl(r.url);
  console.log(`opening ${r.url}`);
}
function cmdAutostart(argv) {
  const sub = argv[0];
  if (sub === "off") { service.autostartOff(); return console.log("autostart disabled"); }
  const r = service.autostartOn();
  if (r.platform === "linux") return console.log(r.note);
  console.log(r.loaded
    ? `✅ autostart enabled — dashboard runs at login and now, at ${r.url}\n   plist: ${r.plist}`
    : `⚠ wrote ${r.plist} but launchctl load failed; run:  launchctl load -w ${r.plist}`);
}
const WARM_PORT = Number(process.env.WARM_PORT || 7677);
function warmUrl() { return `http://localhost:${WARM_PORT}`; }

async function cmdWarm(argv) {
  const sub = argv[0];
  if (sub === "serve") { require("../lib/warm-daemon").serve(); return; }         // internal (daemon body)
  if (sub === "up") {
    const r = service.startDaemon("warm", ["warm", "serve"], { ...bridgeEnv(), WARM_PORT: String(WARM_PORT) });
    return console.log(r.already ? `• warm daemon already running (pid ${r.pid})` : `▶ warm daemon started (pid ${r.pid}) at ${warmUrl()}`);
  }
  if (sub === "down") { const pid = service.stopDaemon("warm"); return console.log(`stopped warm daemon${pid ? ` (pid ${pid})` : ""}`); }
  if (sub === "status") {
    try { const r = await fetch(`${warmUrl()}/status`); const d = await r.json();
      console.log(`warm daemon ● up · ${d.sessions.length} session(s)`);
      for (const s of d.sessions) console.log(`  ${s.name.padEnd(16)} thread ${(s.threadId || "-").slice(0, 12)}  cwd ${s.cwd}`);
    } catch { console.log("warm daemon ○ not running (start it: agent-bridge warm up)"); }
    return;
  }
  // warm send: --session <name> [-C dir] [-s sandbox] "prompt"
  if (sub === "send") {
    const o = parseRun(argv.slice(1));
    if (!o.session) return console.error("--session <name> required") || process.exit(1);
    if (!o.prompt) return console.error("no prompt given") || process.exit(1);
    // auto-start the daemon if needed
    const alive = await new Promise((res) => service.portListening(WARM_PORT, res));
    if (!alive) { service.startDaemon("warm", ["warm", "serve"], { ...bridgeEnv(), WARM_PORT: String(WARM_PORT) });
      await new Promise((res) => { const t = setInterval(() => service.portListening(WARM_PORT, (a) => a && (clearInterval(t), res())), 400); }); }
    try {
      const r = await fetch(`${warmUrl()}/send`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: o.session, prompt: o.prompt, cwd: o.cwd, sandbox: o.sandbox, model: o.model }) });
      const d = await r.json();
      if (d.error) { console.error(`✗ ${d.error}`); process.exit(1); }
      console.log(`── codex (warm, task ${d.task}, session '${o.session}', thread ${(d.threadId || "").slice(0, 8)}, ${d.events} events) ──\n`);
      console.log(d.text);
    } catch (e) { console.error(`✗ warm send failed: ${e.message}`); process.exit(1); }
    return;
  }
  console.error("usage: agent-bridge warm <up|send|status|down>  (send: --session <name> [-C dir] \"prompt\")");
}

function cmdService(argv) {
  const sub = argv[0];
  if (sub === "status" || !sub) return service.status((s) => console.log(
    `dashboard ${s.listening ? "● running" : "○ stopped"} at ${s.url}\n` +
    `autostart: ${s.launchAgent ? "on (launchd)" : s.autostart ? "on" : "off"}`));
  if (sub === "up") return cmdUp(argv.slice(1));
  if (sub === "down") return cmdDown();
  console.error("usage: agent-bridge service [status|up|down]");
}

async function install() {
  console.log("agent-bridge install\n────────────────────");
  doctor();
  // Register direct Codex MCP as an escape hatch. The primary path remains /codex-send
  // -> agent-bridge run -> bridge-owned task ledger -> Codex MCP.
  if (has("codex")) {
    console.log("\n▶ registering codex-direct MCP escape hatch (user scope)…");
    spawnSync("claude", ["mcp", "add", "codex-direct", "--scope", "user", "--", "codex", "mcp-server",
      "-c", "approval_policy=never", "-c", "sandbox_mode=workspace-write"], { stdio: "inherit" });
  }
  const roots = [path.join(HOME, ".agents", "skills"), path.join(HOME, ".claude", "skills")];
  const skillRoot = roots.find((d) => fs.existsSync(d)) || roots[0];
  const names = fs.readdirSync(SKILLS).filter((n) => fs.existsSync(path.join(SKILLS, n, "SKILL.md")));
  for (const n of names) {
    const dest = path.join(skillRoot, n);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(SKILLS, n, "SKILL.md"), path.join(dest, "SKILL.md"));
  }
  console.log(`▶ installed skills [${names.map((n) => "/" + n).join(" ")}] → ${skillRoot}`);
  // Start the dashboard now AND make it auto-run at login.
  console.log("\n▶ starting the telemetry dashboard…");
  const r = service.autostartOn();
  if (r.platform === "mac" && r.loaded) console.log(`  ✅ dashboard running at ${r.url} (auto-starts at login)`);
  else { const u = await service.up(); console.log(`  ✅ dashboard running at ${u.url}`); if (r.note) console.log("  " + r.note.split("\n").join("\n  ")); }
  console.log(`\n✅ Restart Claude Code, then delegate with: "/codex-send <task>" or "/agy-send <task>".`);
  console.log(`   Dashboard:  agent-bridge open`);
}

function doctor() {
  for (const name of AGENT_NAMES) {
    const spec = AGENTS[name];
    const ok = has(spec.bin);
    console.log(`  ${ok ? "✅" : "❌"} ${name} (${spec.bin})${ok ? "" : `  — install it`}`);
  }
  console.log(`  ${has("claude") ? "✅" : "❌"} claude (Claude Code)`);
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run": await cmdRun(rest); break;
    case "list": cmdList(); break;
    case "sessions": cmdSessions(); break;
    case "warm": await cmdWarm(rest); break;
    case "status": showFile(rest, "status.md"); break;
    case "result": showFile(rest, "result.md"); break;
    case "watch": cmdWatch(rest); break;
    case "tokens": py("relay.py", ["tokens"]); break;
    case "otel": py("otel-claude.py", rest); break;
    case "dashboard": await cmdDashboard(rest); break;
    case "up": await cmdUp(rest); break;
    case "down": cmdDown(); break;
    case "open": await cmdOpen(); break;
    case "autostart": cmdAutostart(rest); break;
    case "service": cmdService(rest); break;
    case "install": await install(); break;
    case "doctor": doctor(); break;
    case undefined: case "-h": case "--help": case "help": usage(); break;
    default: console.error(`unknown command: ${cmd}\n`); usage(); process.exit(1);
  }
})();
