"use strict";
/**
 * service — run the dashboard (and OTEL receiver) as background daemons, and
 * optionally auto-start the dashboard at login (macOS launchd / Linux systemd note).
 *
 *   up / down     start/stop the daemons now (idempotent)
 *   autostart     install/remove a login service so it's always running
 */
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const HOME = os.homedir();
const BIN = path.join(__dirname, "..", "bin", "agent-bridge.js");

function bridgeHome() {
  const p = process.env.AGENT_BRIDGE_HOME;
  if (p === "~") return HOME;
  if (p && p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p || path.join(HOME, ".agent-bridge");
}
function relayDb() { return process.env.RELAY_DB || path.join(bridgeHome(), "relay.db"); }
function svcFile(name) { return path.join(bridgeHome(), name); }
function url(port) { return `http://localhost:${port}`; }

function readConfig() {
  try { return JSON.parse(fs.readFileSync(svcFile("service.json"), "utf8")); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(bridgeHome(), { recursive: true });
  fs.writeFileSync(svcFile("service.json"), JSON.stringify(cfg, null, 2));
}
function port() { return readConfig().port || 7676; }

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

/** Is something already listening on the port? (so `up` is idempotent vs launchd). */
function portListening(p, cb) {
  const sock = net.connect({ port: p, host: "127.0.0.1" });
  let done = false;
  const finish = (v) => { if (!done) { done = true; sock.destroy(); cb(v); } };
  sock.setTimeout(400);
  sock.on("connect", () => finish(true));
  sock.on("timeout", () => finish(false));
  sock.on("error", () => finish(false));
}

/** Start a detached background daemon of `agent-bridge <args>`, tracked by a pidfile. */
function startDaemon(name, args, env) {
  const pidFile = svcFile(`${name}.pid`);
  try {
    const old = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    if (old && isAlive(old)) return { name, pid: old, already: true };
  } catch { /* no pidfile */ }
  fs.mkdirSync(bridgeHome(), { recursive: true });
  const log = fs.openSync(svcFile(`${name}.log`), "a");
  const child = spawn(process.execPath, [BIN, ...args],
    { detached: true, stdio: ["ignore", log, log], env: { ...process.env, ...env } });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  return { name, pid: child.pid, already: false };
}

function stopDaemon(name) {
  const pidFile = svcFile(`${name}.pid`);
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    if (pid && isAlive(pid)) { process.kill(pid); }
    fs.rmSync(pidFile, { force: true });
    return pid;
  } catch { return null; }
}

/** up: ensure dashboard (+ otel) are running. */
function up({ port: p } = {}) {
  const chosen = p || port();
  writeConfig({ ...readConfig(), port: chosen });
  return new Promise((resolve) => {
    portListening(chosen, (listening) => {
      const results = [];
      if (listening) results.push({ name: "dashboard", pid: null, already: true });
      else results.push(startDaemon("dashboard", ["dashboard", "--port", String(chosen)],
        { RELAY_DB: relayDb() }));
      results.push(startDaemon("otel", ["otel"], { RELAY_DB: relayDb() }));
      resolve({ port: chosen, url: url(chosen), results });
    });
  });
}

function down() {
  return { dashboard: stopDaemon("dashboard"), otel: stopDaemon("otel") };
}

// ---- login autostart ----
const isMac = process.platform === "darwin";
const LABEL = "com.agent-bridge.dashboard";
const plistPath = path.join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);

function plist(p) {
  const log = svcFile("dashboard.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${BIN}</string>
    <string>dashboard</string>
    <string>--port</string>
    <string>${p}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>RELAY_DB</key><string>${relayDb()}</string>
    <key>AGENT_BRIDGE_HOME</key><string>${bridgeHome()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}

function autostartOn({ port: p } = {}) {
  const chosen = p || port();
  writeConfig({ ...readConfig(), port: chosen, autostart: true });
  if (!isMac) {
    return { platform: "linux", note:
      `Autostart on Linux: add to your session or create a systemd user unit running\n` +
      `  ${process.execPath} ${BIN} dashboard --port ${chosen}\n` +
      `For now, 'agent-bridge up' keeps it running until logout.` };
  }
  stopDaemon("dashboard"); // free the port so launchd's instance can bind it
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist(chosen));
  spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" }); // in case it exists
  const r = spawnSync("launchctl", ["load", "-w", plistPath], { stdio: "ignore" });
  return { platform: "mac", plist: plistPath, port: chosen, url: url(chosen), loaded: r.status === 0 };
}

function autostartOff() {
  writeConfig({ ...readConfig(), autostart: false });
  if (!isMac) return { platform: "linux" };
  spawnSync("launchctl", ["unload", "-w", plistPath], { stdio: "ignore" });
  fs.rmSync(plistPath, { force: true });
  return { platform: "mac", removed: true };
}

function status(cb) {
  const p = port();
  const cfg = readConfig();
  portListening(p, (listening) => {
    cb({ port: p, url: url(p), listening, autostart: !!cfg.autostart,
      launchAgent: isMac && fs.existsSync(plistPath) });
  });
}

module.exports = { up, down, autostartOn, autostartOff, status, port, url, bridgeHome, isMac };
