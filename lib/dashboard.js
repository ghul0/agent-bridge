"use strict";
/**
 * dashboard - a dependency-free local telemetry dashboard for agent-bridge.
 *
 * The server reads the filesystem work-log and relay export live on every request.
 * It intentionally stays stdlib-only so `agent-bridge dashboard` has no build step.
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawnSync } = require("child_process");
const fslog = require("./fslog");

const DEFAULT_PORT = 7676;
const MAX_EVENTS = 200;
const AGENT_COLORS = { claude: "#D97757", codex: "#E0A44E", gemini: "#8B9DC9", antigravity: "#6FBF8B" };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function firstWord(v) {
  return String(v || "").trim().split(/\s+/)[0] || "";
}

function cleanNeedsInput(v) {
  const s = String(v || "").trim();
  return s.startsWith("#") ? "" : s;
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function readTelemetryRollup(dir) {
  const telemetry = readJson(path.join(dir, "telemetry.json"), null);
  return telemetry && typeof telemetry === "object" ? telemetry : null;
}

function parseUsageString(value) {
  if (!value) return null;
  try { return normalizeUsage(JSON.parse(value)); } catch { return null; }
}

function emptyUsage() {
  return { input: 0, output: 0, cached: 0, reasoning: 0 };
}

function addUsage(a, b) {
  a.input += num(b.input);
  a.output += num(b.output);
  a.cached += num(b.cached);
  a.reasoning += num(b.reasoning);
  return a;
}

function normalizeUsage(usage) {
  usage = usage || {};
  const nested = usage.usage || {};
  return {
    input: num(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ??
      usage.promptTokenCount ?? nested.input_tokens ?? nested.promptTokenCount),
    output: num(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ??
      usage.candidatesTokenCount ?? nested.output_tokens ?? nested.candidatesTokenCount),
    cached: num(usage.cached_input_tokens ?? usage.cachedInputTokens ??
      usage.cachedContentTokenCount ?? usage.cacheRead ?? nested.cached_input_tokens),
    reasoning: num(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens ??
      usage.thoughtsTokenCount ?? nested.reasoning_output_tokens),
  };
}

function isoOrEmpty(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : "";
}

function durationSec(start, end) {
  const a = Date.parse(start || "");
  const b = Date.parse(end || "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}

function repoName(cwd) {
  if (!cwd) return "";
  return path.basename(cwd.replace(/[\/\\]+$/, "")) || cwd;
}

function readPricing() {
  return readJson(path.join(__dirname, "pricing.json"), {
    default: { inPerM: 0, cachedPerM: 0, outPerM: 0 },
  });
}

function rateFor(model, pricing) {
  const id = String(model || "default").toLowerCase();
  for (const [key, rate] of Object.entries(pricing)) {
    if (key === "default") continue;
    if (id.includes(key.toLowerCase()) && rate && typeof rate === "object") return rate;
  }
  return pricing.default || { inPerM: 0, cachedPerM: 0, outPerM: 0 };
}

function estimateCost(model, usage, pricing) {
  const rate = rateFor(model, pricing);
  const cached = num(usage.cached);
  const input = Math.max(0, num(usage.input) - cached);
  return (input * num(rate.inPerM) + cached * num(rate.cachedPerM) +
    num(usage.output) * num(rate.outPerM)) / 1000000;
}

function parseEventLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function isCompletedItem(ev, itemType) {
  return ev && ev.type === "item.completed" && ev.item && ev.item.type === itemType;
}

function eventUsage(ev) {
  if (!ev) return null;
  if (ev.type === "turn.completed") return normalizeUsage(ev.usage);
  if (ev.usage || ev.usageMetadata || (ev.stats && ev.stats.tokens)) {
    return normalizeUsage(ev.usage || ev.usageMetadata || ev.stats.tokens);
  }
  return null;
}

function readEventStats(file, agent) {
  const stats = { turns: null, commands: 0, fileChanges: 0, usage: emptyUsage() };
  const text = readText(file);
  if (!text) return stats;

  let codexTurns = 0;
  let geminiTurns = 0;
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    const ev = parseEventLine(line);
    if (!ev) continue;

    if (ev.type === "turn.completed") {
      codexTurns += 1;
      addUsage(stats.usage, eventUsage(ev) || emptyUsage());
    } else if (agent === "gemini") {
      const u = eventUsage(ev);
      if (u) addUsage(stats.usage, u);
      if (["assistant", "content", "final", "response.completed"].includes(ev.type || ev.kind)) {
        geminiTurns += 1;
      }
    }

    if (isCompletedItem(ev, "command_execution")) stats.commands += 1;
    if (isCompletedItem(ev, "file_change")) stats.fileChanges += 1;
    if ((ev.type || ev.kind) === "command_execution") stats.commands += 1;
    if ((ev.type || ev.kind) === "file_change") stats.fileChanges += 1;
  }

  if (codexTurns) stats.turns = codexTurns;
  else if (agent === "gemini" && geminiTurns) stats.turns = geminiTurns;
  return stats;
}

function summarizeEvent(ev) {
  if (!ev) return null;
  const type = ev.type || ev.kind || "event";
  const item = ev.item || {};
  const itemType = item.type || type;

  if (type === "item.completed" && itemType === "command_execution") {
    const output = String(item.aggregated_output || "").trim();
    return {
      ts: ev.timestamp || ev.ts || null,
      kind: "command_execution",
      text: String(item.command || "(command)").trim().slice(0, 600),
      detail: output.slice(0, 600),
    };
  }
  if (type === "item.completed" && itemType === "file_change") {
    const changes = (item.changes || []).map((c) => `${c.kind || "change"} ${c.path || ""}`.trim());
    return { ts: ev.timestamp || ev.ts || null, kind: "file_change", text: changes.join(", ").slice(0, 600) };
  }
  if (type === "item.completed" && itemType === "agent_message") {
    return {
      ts: ev.timestamp || ev.ts || null,
      kind: "agent_message",
      text: String(item.text || item.message || "").trim().slice(0, 800),
    };
  }
  if (type === "turn.completed") {
    const u = normalizeUsage(ev.usage);
    return {
      ts: ev.timestamp || ev.ts || null,
      kind: "turn.completed",
      text: `in ${u.input.toLocaleString()} / out ${u.output.toLocaleString()} / cached ${u.cached.toLocaleString()}`,
    };
  }
  if (itemType === "error" || type === "error") {
    return { ts: ev.timestamp || ev.ts || null, kind: "error", text: String(item.message || ev.message || "").slice(0, 800) };
  }
  if (["assistant", "content", "final", "response.completed"].includes(type)) {
    return { ts: ev.timestamp || ev.ts || null, kind: "agent_message", text: String(ev.text || ev.content || ev.message || type).slice(0, 800) };
  }
  return null;
}

function readEventSummaries(file) {
  const items = [];
  for (const line of readText(file).split(/\n/)) {
    if (!line.trim()) continue;
    const summary = summarizeEvent(parseEventLine(line));
    if (summary) items.push(summary);
  }
  return items.slice(-MAX_EVENTS);
}

function summarizeTelemetryEvent(ev) {
  if (!ev) return null;
  if (ev.type === "command") {
    return {
      ts: ev.ts || null,
      kind: "command",
      text: String(ev.command || "(command)").slice(0, 600),
      detail: String(ev.output || ev.status || "").slice(0, 600),
    };
  }
  if (ev.type === "file.edit") {
    const p = ev.params || {};
    return {
      ts: ev.ts || null,
      kind: "file.edit",
      text: String(p.path || ev.path || "(file edit)").slice(0, 600),
      detail: String(p.toolSummary || p.toolAction || p.description || "").slice(0, 600),
    };
  }
  if (ev.type === "tool.start") {
    const p = ev.params || {};
    return {
      ts: ev.ts || null,
      kind: `tool.${ev.tool || "start"}`,
      text: String(p.path || p.command || p.toolSummary || ev.tool || "").slice(0, 600),
    };
  }
  if (ev.type === "llm.usage") {
    return {
      ts: ev.ts || null,
      kind: "llm.usage",
      text: `in ${num(ev.tokensIn).toLocaleString()} / out ${num(ev.tokensOut).toLocaleString()} / cached ${num(ev.cached).toLocaleString()}`,
    };
  }
  if (ev.type === "message.out" || ev.type === "message.in") {
    return { ts: ev.ts || null, kind: ev.type, text: String(ev.message || "").slice(0, 800) };
  }
  if (ev.type === "agent.start" || ev.type === "agent.end") {
    return { ts: ev.ts || null, kind: ev.type, text: ev.agent || "" };
  }
  return null;
}

function readTelemetrySummaries(file) {
  const items = [];
  for (const line of readText(file).split(/\n/)) {
    if (!line.trim()) continue;
    const summary = summarizeTelemetryEvent(parseEventLine(line));
    if (summary) items.push(summary);
  }
  return items.slice(-MAX_EVENTS);
}

function loadTask(id) {
  const dir = fslog.taskDir(id);
  if (!dir) return null;
  const taskFile = path.join(dir, "task.md");
  const statusFile = path.join(dir, "status.md");
  const task = fslog.parse(readText(taskFile));
  const status = fslog.parse(readText(statusFile));
  const fields = task.fields;
  const statusFields = status.fields;
  const agent = firstWord(statusFields.agent || fields.agent || "unknown");
  const telemetry = readTelemetryRollup(dir);
  const stats = readEventStats(path.join(dir, "events.jsonl"), agent);
  const fallbackUsage = parseUsageString(fields.usage);
  const telemetryUsage = telemetry ? {
    input: num(telemetry.tokensIn),
    output: num(telemetry.tokensOut),
    cached: num(telemetry.cached),
    reasoning: num(telemetry.reasoning),
  } : null;
  const usage = telemetryUsage && (telemetryUsage.input || telemetryUsage.output || telemetryUsage.cached || telemetryUsage.reasoning) ?
    telemetryUsage : (stats.usage.input || stats.usage.output || stats.usage.cached || stats.usage.reasoning) ?
    stats.usage : (fallbackUsage || stats.usage);
  const createdIso = isoOrEmpty(fields.created);
  const finishedIso = isoOrEmpty(fields.finished);
  const updatedIso = isoOrEmpty(statusFields.updated);
  const statusName = firstWord(statusFields.status || fields.status || "queued");
  const telemetryEvents = telemetry ? readTelemetrySummaries(path.join(dir, "telemetry.jsonl")) : [];
  const progress = Math.max(0, Math.min(100, parseInt(statusFields.progress || "0", 10) || 0));

  return {
    id: path.basename(dir),
    dir,
    frontmatter: fields,
    status: {
      ...statusFields,
      agent,
      status: statusName,
      progress,
      needs_input: cleanNeedsInput(statusFields.needs_input),
    },
    statusBody: status.body || "",
    result: readText(path.join(dir, "result.md")),
    telemetry,
    events: telemetryEvents.length ? telemetryEvents : readEventSummaries(path.join(dir, "events.jsonl")),
    session: {
      id: path.basename(dir),
      agent,
      repo: repoName(fields.cwd),
      cwd: fields.cwd || "",
      status: statusName,
      progress,
      createdIso,
      finishedIso,
      durationSec: telemetry && telemetry.durationSec != null ? num(telemetry.durationSec) : durationSec(createdIso, finishedIso || updatedIso),
      turns: telemetry && telemetry.turns != null ? num(telemetry.turns) : stats.turns,
      commands: telemetry && telemetry.commands != null ? num(telemetry.commands) : stats.commands,
      fileChanges: telemetry && telemetry.fileChanges != null ? num(telemetry.fileChanges) : stats.fileChanges,
      tokensIn: usage.input,
      tokensOut: usage.output,
      cached: usage.cached,
      reasoning: usage.reasoning,
      costUsd: 0,
      summary: statusFields.summary || "",
      telemetry: telemetry ? {
        verified: telemetry.verified,
        hashChain: telemetry.hashChain,
        selfReportGap: telemetry.selfReportGap,
        tools: telemetry.tools,
        actions: telemetry.actions,
      } : null,
    },
  };
}

function loadTasks(pricing) {
  return fslog.listTasks().map((t) => loadTask(t.id)).filter(Boolean).map((task) => {
    task.session.costUsd = estimateCost(task.session.agent, {
      input: task.session.tokensIn,
      output: task.session.tokensOut,
      cached: task.session.cached,
    }, pricing);
    return task;
  });
}

function relayExport() {
  const r = spawnSync("python3", [path.join(__dirname, "relay.py"), "export"], {
    encoding: "utf8",
    env: process.env,
    timeout: 5000,
  });
  if (r.status !== 0) return { claude_tokens: [], claude_sessions: [] };
  try {
    const out = JSON.parse(r.stdout || "{}");
    return {
      claude_tokens: Array.isArray(out.claude_tokens) ? out.claude_tokens : [],
      claude_sessions: Array.isArray(out.claude_sessions) ? out.claude_sessions : [],
    };
  } catch {
    return { claude_tokens: [], claude_sessions: [] };
  }
}

function claudeByModel(tokens) {
  const models = {};
  for (const row of tokens) {
    const model = row.model || "claude";
    const d = models[model] || (models[model] = { input: 0, output: 0, cached: 0, reasoning: 0, updated: "" });
    const typ = row.type || "";
    if (typ === "output") d.output += num(row.tokens);
    else if (typ === "cacheRead" || typ === "cacheCreation") {
      d.input += num(row.tokens);
      d.cached += num(row.tokens);
    } else d.input += num(row.tokens);
    if (row.updated && (!d.updated || Date.parse(row.updated) > Date.parse(d.updated))) d.updated = row.updated;
  }
  return models;
}

function claudeAggregate(relay, pricing) {
  const byModel = claudeByModel(relay.claude_tokens);
  const usage = emptyUsage();
  let estimate = 0;
  for (const [model, data] of Object.entries(byModel)) {
    addUsage(usage, data);
    estimate += estimateCost(model, data, pricing);
  }
  const realCost = relay.claude_sessions.reduce((sum, s) => sum + num(s.cost_usd), 0);
  return { ...usage, costUsd: realCost || estimate, hasRealCost: realCost > 0 };
}

function claudeSessionRows(relay) {
  return relay.claude_sessions.map((s) => {
    const updated = isoOrEmpty(s.updated);
    return {
      id: s.session_id || "(unknown)",
      agent: "claude",
      repo: s.model || "Claude Code",
      cwd: "",
      status: "done",
      progress: 100,
      createdIso: updated,
      finishedIso: updated,
      durationSec: null,
      turns: null,
      commands: null,
      fileChanges: num(s.lines_added) + num(s.lines_removed),
      tokensIn: num(s.input) + num(s.cacheRead) + num(s.cacheCreation),
      tokensOut: num(s.output),
      cached: num(s.cacheRead) + num(s.cacheCreation),
      reasoning: 0,
      costUsd: num(s.cost_usd),
      summary: `Claude Code telemetry for ${s.model || "unknown model"}`,
    };
  });
}

function bucketKey(iso, hourly) {
  const d = new Date(iso || "");
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  if (!hourly) return `${y}-${m}-${day}`;
  return `${y}-${m}-${day} ${String(d.getUTCHours()).padStart(2, "0")}:00`;
}

function buildSeries(taskSessions, claudeSessions, relay) {
  const dated = [];
  for (const s of taskSessions) dated.push(s);
  for (const s of claudeSessions) dated.push(s);

  if (!claudeSessions.length) {
    for (const row of relay.claude_tokens) {
      if (!row.updated) continue;
      dated.push({
        agent: "claude",
        createdIso: row.updated,
        tokensIn: row.type === "output" ? 0 : num(row.tokens),
        tokensOut: row.type === "output" ? num(row.tokens) : 0,
      });
    }
  }

  const days = new Set(dated.map((s) => bucketKey(s.createdIso || s.finishedIso, false)).filter(Boolean));
  const hourly = days.size <= 1;
  const buckets = {};
  for (const s of dated) {
    const key = bucketKey(s.createdIso || s.finishedIso, hourly);
    if (!key) continue;
    const b = buckets[key] || (buckets[key] = { date: key, claude: 0, codex: 0, gemini: 0 });
    const agent = ["claude", "codex", "gemini"].includes(s.agent) ? s.agent : s.agent || "codex";
    if (!Object.prototype.hasOwnProperty.call(b, agent)) b[agent] = 0;
    b[agent] += num(s.tokensIn) + num(s.tokensOut);
  }
  return Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
}

function collectData() {
  const pricing = readPricing();
  const relay = relayExport();
  const tasks = loadTasks(pricing);
  const taskSessions = tasks.map((t) => t.session);
  const claudeSessions = claudeSessionRows(relay);
  const claude = claudeAggregate(relay, pricing);
  const agents = {
    claude: { agent: "claude", tokensIn: claude.input, tokensOut: claude.output, cached: claude.cached, costUsd: claude.costUsd },
    codex: { agent: "codex", tokensIn: 0, tokensOut: 0, cached: 0, costUsd: 0 },
    gemini: { agent: "gemini", tokensIn: 0, tokensOut: 0, cached: 0, costUsd: 0 },
  };

  for (const s of taskSessions) {
    const a = agents[s.agent] || (agents[s.agent] = { agent: s.agent, tokensIn: 0, tokensOut: 0, cached: 0, costUsd: 0 });
    a.tokensIn += num(s.tokensIn);
    a.tokensOut += num(s.tokensOut);
    a.cached += num(s.cached);
    a.costUsd += num(s.costUsd);
  }

  const byAgent = Object.values(agents);
  const grand = byAgent.reduce((sum, a) => sum + a.tokensIn + a.tokensOut, 0);
  for (const a of byAgent) a.share = grand ? (a.tokensIn + a.tokensOut) / grand : 0;

  const turnCounts = taskSessions.map((s) => s.turns).filter((v) => v != null);
  const failures = taskSessions.filter((s) => ["error", "blocked"].includes(s.status)).length;
  const totals = {
    tokensIn: byAgent.reduce((sum, a) => sum + a.tokensIn, 0),
    tokensOut: byAgent.reduce((sum, a) => sum + a.tokensOut, 0),
    cached: byAgent.reduce((sum, a) => sum + a.cached, 0),
    reasoning: taskSessions.reduce((sum, s) => sum + num(s.reasoning), 0),
    costUsd: byAgent.reduce((sum, a) => sum + a.costUsd, 0),
    tasks: taskSessions.length,
    failures,
    avgTurns: turnCounts.length ? turnCounts.reduce((a, b) => a + b, 0) / turnCounts.length : 0,
    cacheHitPct: byAgent.reduce((sum, a) => sum + a.tokensIn, 0) ?
      100 * byAgent.reduce((sum, a) => sum + a.cached, 0) / byAgent.reduce((sum, a) => sum + a.tokensIn, 0) : 0,
  };

  const sessions = taskSessions.concat(claudeSessions).sort((a, b) =>
    Date.parse(b.createdIso || b.finishedIso || 0) - Date.parse(a.createdIso || a.finishedIso || 0));

  return {
    totals,
    byAgent,
    series: buildSeries(taskSessions, claudeSessions, relay),
    sessions,
    tasks,
  };
}

function send(res, code, type, body) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res, code, data) {
  send(res, code, "application/json", JSON.stringify(data));
}

function requestHandler(req, res) {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", HTML);
    if (url.pathname === "/api/summary") {
      const data = collectData();
      return sendJson(res, 200, { totals: data.totals, byAgent: data.byAgent, series: data.series });
    }
    if (url.pathname === "/api/sessions") return sendJson(res, 200, collectData().sessions);
    const m = /^\/api\/task\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const task = loadTask(decodeURIComponent(m[1]));
      if (!task) return sendJson(res, 404, { error: "task not found" });
      return sendJson(res, 200, {
        frontmatter: task.frontmatter,
        status: task.status,
        statusBody: task.statusBody,
        result: task.result,
        events: task.events,
        telemetry: task.telemetry,
      });
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    return sendJson(res, 500, { error: e.message || String(e) });
  }
}

function startServer(options = {}) {
  const port = options.port == null ? DEFAULT_PORT : Number(options.port);
  const host = options.host || "0.0.0.0";
  const server = http.createServer(requestHandler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({ server, url: `http://localhost:${actual}`, port: actual });
    });
  });
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-bridge telemetry</title>
<style>
:root {
  --bg: #1A1712;
  --surface: #221E17;
  --surface-2: #2A251C;
  --border: #3A3329;
  --text: #F0EADE;
  --text-2: #B8AF9F;
  --muted: #857C6D;
  --accent: #D97757;
  --accent-br: #E8916B;
  --good: #6FBF8B;
  --warn: #E0A44E;
  --bad: #D9615A;
  --claude: #D97757;
  --codex: #E0A44E;
  --gemini: #8B9DC9;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  min-height: 100vh;
}
button, input { font: inherit; }
button { cursor: pointer; }
.wrap {
  max-width: 1280px;
  margin: 0 auto;
  padding: 28px 24px 44px;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 26px;
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.brand-dot {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 5px rgba(217, 119, 87, .12);
}
.brand strong {
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  font-size: clamp(28px, 4vw, 43px);
  font-weight: 600;
  letter-spacing: 0;
}
.brand span { color: var(--muted); font-size: 15px; }
.live {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--text-2);
  font-size: 14px;
}
.live-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--good);
  box-shadow: 0 0 0 0 rgba(111, 191, 139, .55);
  animation: pulse 1.8s infinite;
}
.toggle {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 8px;
  padding: 7px 12px;
}
.toggle[aria-pressed="true"] { border-color: var(--accent); color: var(--accent-br); }
.grid {
  display: grid;
  gap: 14px;
}
.kpis {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin-bottom: 18px;
}
.tile, .panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.tile {
  padding: 15px 15px 13px;
  border-top: 3px solid var(--accent);
  min-width: 0;
}
.label {
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .08em;
  font-size: 11px;
  font-weight: 700;
}
.value {
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  font-size: clamp(28px, 3.2vw, 44px);
  line-height: 1;
  margin-top: 8px;
}
.sub { color: var(--text-2); font-size: 13px; margin-top: 8px; min-height: 18px; }
.panels {
  grid-template-columns: minmax(320px, .85fr) minmax(440px, 1.15fr);
  margin-bottom: 18px;
}
.panel { padding: 18px; min-width: 0; }
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.panel h2 {
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  font-size: 22px;
  font-weight: 600;
  margin: 0;
}
.chart-row {
  display: grid;
  grid-template-columns: 210px 1fr;
  align-items: center;
  gap: 18px;
}
svg { display: block; width: 100%; height: auto; }
.legend { display: grid; gap: 10px; }
.legend-row {
  display: grid;
  grid-template-columns: 12px minmax(60px, 1fr) auto;
  align-items: center;
  gap: 9px;
  color: var(--text-2);
  font-size: 14px;
}
.chip-dot { width: 10px; height: 10px; border-radius: 50%; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.table-panel { padding: 0; overflow: hidden; }
.table-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 17px 18px;
  border-bottom: 1px solid var(--border);
}
.table-title h2 {
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  margin: 0;
  font-size: 23px;
}
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; min-width: 920px; }
th, td {
  padding: 12px 14px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
th {
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .08em;
  font-size: 11px;
  font-weight: 700;
  user-select: none;
}
th button {
  color: inherit;
  background: transparent;
  border: 0;
  padding: 0;
  text-transform: inherit;
  letter-spacing: inherit;
  font-size: inherit;
  font-weight: inherit;
}
tbody tr:nth-child(odd) { background: rgba(42, 37, 28, .35); }
tbody tr[data-task="true"] { cursor: pointer; }
tbody tr[data-task="true"]:hover { background: rgba(217, 119, 87, .09); }
tbody tr:focus-within { outline: 2px solid var(--accent-br); outline-offset: -2px; }
.agent {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  text-transform: capitalize;
}
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 74px;
  border: 1px solid currentColor;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 12px;
  text-transform: capitalize;
}
.status-done { color: var(--good); }
.status-working { color: var(--warn); }
.status-blocked { color: #D98A3D; }
.status-error { color: var(--bad); }
.status-queued { color: var(--muted); }
.progress {
  height: 2px;
  background: rgba(224, 164, 78, .22);
  margin: 8px -14px -12px;
}
.progress span { display: block; height: 100%; background: var(--warn); width: 0; }
.empty {
  padding: 34px 18px;
  color: var(--text-2);
  text-align: center;
}
.drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, .44);
  opacity: 0;
  pointer-events: none;
  transition: opacity .18s ease;
  z-index: 20;
}
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: min(560px, 100vw);
  height: 100vh;
  background: var(--surface-2);
  border-left: 1px solid var(--border);
  transform: translateX(100%);
  transition: transform .22s ease;
  z-index: 21;
  overflow-y: auto;
  padding: 22px;
}
body.drawer-open .drawer-backdrop { opacity: 1; pointer-events: auto; }
body.drawer-open .drawer { transform: translateX(0); }
.drawer-head {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: flex-start;
  margin-bottom: 18px;
}
.drawer h2 {
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  margin: 4px 0 4px;
  font-size: 29px;
  overflow-wrap: anywhere;
}
.close {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}
.section { margin: 18px 0; }
.section h3 {
  margin: 0 0 9px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .08em;
  font-size: 11px;
}
pre {
  margin: 0;
  background: rgba(26, 23, 18, .62);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text-2);
}
.needs {
  border: 1px solid #D98A3D;
  background: rgba(217, 138, 61, .12);
  color: var(--text);
  border-radius: 8px;
  padding: 11px 12px;
  margin-bottom: 14px;
}
.timeline { display: grid; gap: 9px; }
.event {
  display: grid;
  grid-template-columns: 122px 1fr;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: rgba(34, 30, 23, .62);
}
.kind {
  color: var(--accent-br);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.event p { margin: 0; color: var(--text-2); overflow-wrap: anywhere; }
.tooltip {
  position: fixed;
  pointer-events: none;
  background: #15120E;
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  opacity: 0;
  z-index: 30;
}
button:focus-visible, tr:focus-visible, a:focus-visible {
  outline: 2px solid var(--accent-br);
  outline-offset: 2px;
}
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(111, 191, 139, .55); }
  70% { box-shadow: 0 0 0 8px rgba(111, 191, 139, 0); }
  100% { box-shadow: 0 0 0 0 rgba(111, 191, 139, 0); }
}
@media (max-width: 1050px) {
  .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .panels { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .wrap { padding: 20px 14px 32px; }
  .topbar { align-items: flex-start; flex-direction: column; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .chart-row { grid-template-columns: 1fr; }
}
@media (max-width: 470px) {
  .kpis { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <div class="brand"><span class="brand-dot" aria-hidden="true"></span><strong>agent-bridge</strong><span>telemetry</span></div>
    <div class="live">
      <span class="live-dot" aria-hidden="true"></span>
      <span aria-label="live status">live</span>
      <span id="updated">updated never</span>
      <button id="pause" class="toggle" aria-pressed="false">pause</button>
    </div>
  </header>

  <section class="grid kpis" aria-label="Key metrics">
    <div class="tile"><div class="label">Total tokens</div><div id="kpi-tokens" class="value">0</div><div id="kpi-tokens-sub" class="sub">in + out</div></div>
    <div class="tile"><div class="label">Est. cost</div><div id="kpi-cost" class="value">$0.00</div><div class="sub">USD, pricing.json editable</div></div>
    <div class="tile"><div class="label">Tasks run</div><div id="kpi-tasks" class="value">0</div><div id="kpi-tasks-sub" class="sub">filesystem work-log</div></div>
    <div class="tile"><div class="label">Avg turns/task</div><div id="kpi-turns" class="value">0</div><div class="sub">tasks with turn counts</div></div>
    <div class="tile"><div class="label">Cache-hit %</div><div id="kpi-cache" class="value">0%</div><div id="kpi-cache-sub" class="sub">cached / input</div></div>
    <div class="tile"><div class="label">Failure %</div><div id="kpi-failure" class="value">0%</div><div id="kpi-failure-sub" class="sub">blocked or error</div></div>
  </section>

  <section class="grid panels">
    <div class="panel">
      <div class="panel-head"><h2>Token share by agent</h2><span class="label">in + out</span></div>
      <div class="chart-row">
        <div id="donut" aria-label="Token share donut chart"></div>
        <div id="legend" class="legend"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Tokens over time</h2><span class="label">stacked by agent</span></div>
      <div id="bars" aria-label="Tokens over time stacked bar chart"></div>
    </div>
  </section>

  <section class="panel table-panel">
    <div class="table-title"><h2>Sessions</h2><span id="session-count" class="label">0 rows</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th><button data-sort="createdIso">Time</button></th>
          <th><button data-sort="agent">Agent</button></th>
          <th><button data-sort="id">Task</button></th>
          <th><button data-sort="repo">Repo</button></th>
          <th><button data-sort="status">Status</button></th>
          <th><button data-sort="turns">Turns</button></th>
          <th><button data-sort="tokensIn">In</button></th>
          <th><button data-sort="tokensOut">Out</button></th>
          <th><button data-sort="cached">Cached</button></th>
          <th><button data-sort="durationSec">Dur.</button></th>
        </tr></thead>
        <tbody id="sessions"><tr><td colspan="10" class="empty">Loading telemetry...</td></tr></tbody>
      </table>
    </div>
  </section>
</div>

<div id="tip" class="tooltip" role="status"></div>
<div id="backdrop" class="drawer-backdrop" tabindex="-1" aria-hidden="true"></div>
<aside id="drawer" class="drawer" aria-label="Task detail drawer" aria-hidden="true">
  <div class="drawer-head">
    <div><div class="label">task detail</div><h2 id="drawer-title">Task</h2><div id="drawer-summary" class="sub"></div></div>
    <button id="close" class="close" aria-label="Close detail drawer">x</button>
  </div>
  <div id="drawer-needs"></div>
  <div class="section"><h3>Telemetry</h3><pre id="drawer-telemetry"></pre></div>
  <div class="section"><h3>Status</h3><pre id="drawer-status"></pre></div>
  <div class="section"><h3>Result</h3><pre id="drawer-result"></pre></div>
  <div class="section"><h3>Events</h3><div id="drawer-events" class="timeline"></div></div>
</aside>

<script>
(function () {
  "use strict";
  var state = { summary: null, sessions: [], sort: "createdIso", dir: "desc", paused: false, lastUpdated: 0 };
  var colors = { claude: "#D97757", codex: "#E0A44E", gemini: "#8B9DC9", antigravity: "#6FBF8B" };
  var timer = null;

  function $(id) { return document.getElementById(id); }
  function fmt(n) { return Math.round(Number(n) || 0).toLocaleString(); }
  function money(n) { return "$" + (Number(n) || 0).toFixed(2); }
  function pct(n) { return ((Number(n) || 0)).toFixed(0) + "%"; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function dur(sec) {
    if (sec == null) return "-";
    sec = Math.max(0, Number(sec) || 0);
    if (sec < 60) return Math.round(sec) + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m " + Math.round(sec % 60) + "s";
    return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
  }
  function ago(iso) {
    var ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "-";
    var d = new Date(ms);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function agentColor(agent) { return colors[agent] || "#B8AF9F"; }

  function renderKpis(data) {
    var t = data.totals || {};
    var totalTokens = (t.tokensIn || 0) + (t.tokensOut || 0);
    $("kpi-tokens").textContent = fmt(totalTokens);
    $("kpi-tokens-sub").textContent = fmt(t.tokensIn) + " in / " + fmt(t.tokensOut) + " out";
    $("kpi-cost").textContent = money(t.costUsd);
    $("kpi-tasks").textContent = fmt(t.tasks);
    $("kpi-tasks-sub").textContent = fmt(t.failures) + " blocked/error";
    $("kpi-turns").textContent = (Number(t.avgTurns) || 0).toFixed(1);
    $("kpi-cache").textContent = pct(t.cacheHitPct);
    $("kpi-cache-sub").textContent = fmt(t.cached) + " cached tokens";
    $("kpi-failure").textContent = pct(t.tasks ? 100 * (t.failures || 0) / t.tasks : 0);
    $("kpi-failure-sub").textContent = fmt(t.failures) + " of " + fmt(t.tasks);
  }

  function donutPath(cx, cy, r, start, end) {
    var sx = cx + r * Math.cos(start), sy = cy + r * Math.sin(start);
    var ex = cx + r * Math.cos(end), ey = cy + r * Math.sin(end);
    var large = end - start > Math.PI ? 1 : 0;
    return "M " + sx + " " + sy + " A " + r + " " + r + " 0 " + large + " 1 " + ex + " " + ey;
  }

  function renderDonut(rows) {
    var total = rows.reduce(function (s, r) { return s + (r.tokensIn || 0) + (r.tokensOut || 0); }, 0);
    var html = '<svg viewBox="0 0 220 220" role="img" aria-label="Token share by agent">';
    html += '<circle cx="110" cy="110" r="74" fill="none" stroke="#3A3329" stroke-width="24"/>';
    var angle = -Math.PI / 2;
    rows.forEach(function (r) {
      var v = (r.tokensIn || 0) + (r.tokensOut || 0);
      if (!total || !v) return;
      var next = angle + (v / total) * Math.PI * 2;
      html += '<path d="' + donutPath(110, 110, 74, angle, next) + '" fill="none" stroke="' + agentColor(r.agent) + '" stroke-width="24" stroke-linecap="butt"/>';
      angle = next;
    });
    html += '<text x="110" y="105" text-anchor="middle" fill="#F0EADE" font-size="24" font-family="ui-serif, Georgia">' + fmt(total) + '</text>';
    html += '<text x="110" y="127" text-anchor="middle" fill="#857C6D" font-size="12">tokens</text></svg>';
    $("donut").innerHTML = html;
    $("legend").innerHTML = rows.map(function (r) {
      var v = (r.tokensIn || 0) + (r.tokensOut || 0);
      var share = total ? 100 * v / total : 0;
      return '<div class="legend-row"><span class="chip-dot" style="background:' + agentColor(r.agent) + '"></span><span>' +
        esc(r.agent) + ' <span class="mono">' + share.toFixed(0) + '%</span></span><span class="mono">' + fmt(v) + '</span></div>';
    }).join("");
  }

  function renderBars(series) {
    var rows = series || [];
    if (!rows.length) {
      $("bars").innerHTML = '<div class="empty">No token history yet.</div>';
      return;
    }
    var w = 720, h = 260, pad = 34;
    var agents = Object.keys(colors);
    rows.forEach(function (r) {
      Object.keys(r).forEach(function (k) { if (k !== "date" && agents.indexOf(k) < 0) agents.push(k); });
    });
    var max = rows.reduce(function (m, r) {
      return Math.max(m, agents.reduce(function (s, agent) { return s + (r[agent] || 0); }, 0));
    }, 1);
    var gap = 12;
    var bw = Math.max(12, (w - pad * 2 - gap * (rows.length - 1)) / rows.length);
    var html = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Tokens over time">';
    html += '<line x1="' + pad + '" y1="' + (h - pad) + '" x2="' + (w - pad) + '" y2="' + (h - pad) + '" stroke="#3A3329"/>';
    rows.forEach(function (r, i) {
      var x = pad + i * (bw + gap);
      var y = h - pad;
      agents.slice().reverse().forEach(function (agent) {
        var val = r[agent] || 0;
        var bh = val / max * (h - pad * 2);
        y -= bh;
        if (bh > 0) html += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + bh + '" fill="' + agentColor(agent) + '" data-tip="' +
          esc(r.date + " " + agent + ": " + fmt(val)) + '"></rect>';
      });
      html += '<text x="' + (x + bw / 2) + '" y="' + (h - 9) + '" text-anchor="middle" fill="#857C6D" font-size="10">' + esc(String(r.date).slice(5)) + '</text>';
    });
    html += '</svg>';
    $("bars").innerHTML = html;
    $("bars").querySelectorAll("[data-tip]").forEach(function (el) {
      el.addEventListener("mousemove", function (e) { showTip(e, el.getAttribute("data-tip")); });
      el.addEventListener("mouseleave", hideTip);
    });
  }

  function showTip(e, text) {
    var tip = $("tip");
    tip.textContent = text;
    tip.style.left = (e.clientX + 12) + "px";
    tip.style.top = (e.clientY + 12) + "px";
    tip.style.opacity = "1";
  }
  function hideTip() { $("tip").style.opacity = "0"; }

  function sortSessions(rows) {
    var key = state.sort, dir = state.dir === "asc" ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (key === "createdIso") { av = Date.parse(av || 0); bv = Date.parse(bv || 0); }
      if (typeof av === "number" || typeof bv === "number") return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
      return String(av || "").localeCompare(String(bv || "")) * dir;
    });
  }

  function renderTable(rows) {
    $("session-count").textContent = rows.length + " rows";
    if (!rows.length) {
      $("sessions").innerHTML = '<tr><td colspan="10" class="empty">No tasks yet - run <span class="mono">agent-bridge run --agent codex ...</span></td></tr>';
      return;
    }
    $("sessions").innerHTML = sortSessions(rows).map(function (s) {
      var task = s.agent !== "claude";
      var progress = s.status === "working" ? '<div class="progress"><span style="width:' + Math.max(0, Math.min(100, s.progress || 0)) + '%"></span></div>' : "";
      return '<tr tabindex="0" data-task="' + (task ? "true" : "false") + '" data-id="' + esc(s.id) + '">' +
        '<td>' + esc(ago(s.createdIso)) + progress + '</td>' +
        '<td><span class="agent"><span class="chip-dot" style="background:' + agentColor(s.agent) + '"></span>' + esc(s.agent) + '</span></td>' +
        '<td class="mono" title="' + esc(s.id) + '">' + esc(String(s.id).slice(0, 24)) + '</td>' +
        '<td>' + esc(s.repo || "-") + '</td>' +
        '<td><span class="badge status-' + esc(s.status || "queued") + '">' + esc(s.status || "queued") + '</span></td>' +
        '<td class="mono">' + (s.turns == null ? "-" : fmt(s.turns)) + '</td>' +
        '<td class="mono">' + fmt(s.tokensIn) + '</td>' +
        '<td class="mono">' + fmt(s.tokensOut) + '</td>' +
        '<td class="mono">' + fmt(s.cached) + '</td>' +
        '<td class="mono">' + dur(s.durationSec) + '</td></tr>';
    }).join("");
    $("sessions").querySelectorAll('tr[data-task="true"]').forEach(function (tr) {
      tr.addEventListener("click", function () { openTask(tr.getAttribute("data-id")); });
      tr.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTask(tr.getAttribute("data-id")); }
      });
    });
  }

  function renderAll() {
    if (!state.summary) return;
    renderKpis(state.summary);
    renderDonut(state.summary.byAgent || []);
    renderBars(state.summary.series || []);
    renderTable(state.sessions);
    $("updated").textContent = "updated 0s ago";
    state.lastUpdated = Date.now();
  }

  function fetchJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " failed");
      return r.json();
    });
  }

  function refresh() {
    if (state.paused) return;
    Promise.all([fetchJson("/api/summary"), fetchJson("/api/sessions")]).then(function (all) {
      state.summary = all[0];
      state.sessions = all[1];
      renderAll();
    }).catch(function (e) {
      $("updated").textContent = "error: " + e.message;
    });
  }

  function openTask(id) {
    fetchJson("/api/task/" + encodeURIComponent(id)).then(function (task) {
      $("drawer-title").textContent = id;
      $("drawer-summary").textContent = (task.status && task.status.summary) || "";
      $("drawer-needs").innerHTML = task.status && task.status.needs_input ?
        '<div class="needs">&#9888; agent is asking Claude: ' + esc(task.status.needs_input) + '</div>' : "";
      $("drawer-telemetry").textContent = task.telemetry ? JSON.stringify({
        verified: task.telemetry.verified,
        hashChain: task.telemetry.hashChain,
        actions: task.telemetry.actions,
        commands: task.telemetry.commands,
        fileChanges: task.telemetry.fileChanges,
        tools: task.telemetry.tools,
        filesTouched: task.telemetry.filesTouched,
        selfReportGap: task.telemetry.selfReportGap
      }, null, 2) : "(telemetry.json not written yet)";
      $("drawer-status").textContent = task.statusBody || "(status body is empty)";
      $("drawer-result").textContent = task.result || "(result.md not written yet)";
      $("drawer-events").innerHTML = (task.events || []).length ? task.events.map(function (ev) {
        return '<div class="event"><div class="kind">' + esc(ev.kind) + '</div><p>' + esc(ev.text || "") +
          (ev.detail ? "\\n\\n" + esc(ev.detail) : "") + '</p></div>';
      }).join("") : '<div class="empty">No timeline events yet.</div>';
      document.body.classList.add("drawer-open");
      $("drawer").setAttribute("aria-hidden", "false");
      $("close").focus();
    });
  }

  function closeDrawer() {
    document.body.classList.remove("drawer-open");
    $("drawer").setAttribute("aria-hidden", "true");
  }

  document.querySelectorAll("th button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-sort");
      if (state.sort === key) state.dir = state.dir === "asc" ? "desc" : "asc";
      else { state.sort = key; state.dir = key === "createdIso" ? "desc" : "asc"; }
      renderTable(state.sessions);
    });
  });
  $("pause").addEventListener("click", function () {
    state.paused = !state.paused;
    $("pause").setAttribute("aria-pressed", String(state.paused));
    $("pause").textContent = state.paused ? "resume" : "pause";
    if (!state.paused) refresh();
  });
  $("close").addEventListener("click", closeDrawer);
  $("backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
  setInterval(function () {
    if (!state.lastUpdated || state.paused) return;
    $("updated").textContent = "updated " + Math.max(0, Math.round((Date.now() - state.lastUpdated) / 1000)) + "s ago";
  }, 1000);
  timer = setInterval(refresh, 4000);
  refresh();
}());
</script>
</body>
</html>`;

module.exports = { DEFAULT_PORT, startServer, collectData, requestHandler };
