"use strict";
/**
 * telemetry - normalize per-agent action traces into task-local JSONL + rollups.
 *
 * This module stays dependency-free. Antigravity's trajectory store is SQLite, so
 * we invoke the system sqlite3 binary via child_process and parse blob hex output.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ZERO_HASH = "0".repeat(64);
const PRINTABLE_RE = /[\x20-\x7e]{4,}/g;
const SECRET_KEY_RE = /^(api[_-]?key|apikey|password|secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization)$/i;
const ACTION_TYPES = new Set(["tool.start", "command", "file.edit"]);

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p && p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function toMs(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 0 && value < 1000000000000 ? Math.round(value * 1000) : Math.round(value);
  }
  const n = Number(value);
  if (Number.isFinite(n)) return toMs(n);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function readJsonLines(file) {
  const out = [];
  for (const line of readText(file).split(/\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* ignore malformed raw telemetry */ }
  }
  return out;
}

function eventTs(ev, fallback) {
  return toMs(ev && (ev.timestamp ?? ev.ts ?? ev.time)) || fallback;
}

function normalizeUsage(usage) {
  usage = usage || {};
  const nested = usage.usage || {};
  return {
    tokensIn: num(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ??
      usage.promptTokenCount ?? nested.input_tokens ?? nested.promptTokenCount),
    tokensOut: num(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ??
      usage.candidatesTokenCount ?? nested.output_tokens ?? nested.candidatesTokenCount),
    cached: num(usage.cached_input_tokens ?? usage.cachedInputTokens ??
      usage.cachedContentTokenCount ?? usage.cacheRead ?? nested.cached_input_tokens),
    reasoning: num(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens ??
      usage.thoughtsTokenCount ?? nested.reasoning_output_tokens),
  };
}

function redactString(value) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}\b/g, "[REDACTED]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, "[REDACTED]")
    .replace(/\bglpat-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?)[^"',\s;}]+/gi, "$1[REDACTED]");
}

function redact(value, key = "") {
  if (value == null) return value;
  if (typeof value === "string") return SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : redact(v, k);
    return out;
  }
  return value;
}

function statusFromExit(item) {
  if (!item) return "ok";
  if (item.status === "failed" || item.status === "error") return "error";
  if (item.exit_code != null && Number(item.exit_code) !== 0) return "error";
  return "ok";
}

function statusFromAgy(value) {
  return Number(value) === 3 ? "ok" : "error";
}

function harvestCodex(taskdir, startMs, agent) {
  const events = [];
  let offset = 0;
  for (const ev of readJsonLines(path.join(taskdir, "events.jsonl"))) {
    const ts = eventTs(ev, startMs + (++offset));
    const item = ev.item || {};
    if (ev.type === "item.completed" && item.type === "command_execution") {
      events.push({
        ts,
        type: "command",
        command: String(item.command || "").trim(),
        status: statusFromExit(item),
        exitCode: item.exit_code == null ? null : Number(item.exit_code),
        output: String(item.aggregated_output || "").slice(0, 4000),
        agent,
      });
    } else if (ev.type === "item.completed" && item.type === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const normalized = changes.length ? changes : [{ path: item.path, kind: item.kind || "change" }];
      for (const change of normalized) {
        if (!change || !change.path) continue;
        events.push({
          ts,
          type: "file.edit",
          params: { path: change.path, kind: change.kind || "change" },
          agent,
        });
      }
    } else if (ev.type === "item.completed" && item.type === "agent_message") {
      events.push({ ts, type: "message.out", message: String(item.text || item.message || ""), agent });
    } else if (ev.type === "turn.completed") {
      events.push({ ts, type: "llm.usage", ...normalizeUsage(ev.usage), agent });
    }
  }
  return { events, meta: {}, errors: [] };
}

function harvestGeneric(taskdir, startMs, agent) {
  const events = [];
  let offset = 0;
  for (const ev of readJsonLines(path.join(taskdir, "events.jsonl"))) {
    const ts = eventTs(ev, startMs + (++offset));
    const usage = ev.usage || ev.usageMetadata || (ev.stats && ev.stats.tokens);
    if (usage) events.push({ ts, type: "llm.usage", ...normalizeUsage(usage), agent });
    const t = ev.type || ev.kind || "";
    if (["assistant", "content", "final", "response.completed"].includes(t)) {
      events.push({ ts, type: "message.out", message: String(ev.text || ev.content || ev.message || ""), agent });
    }
  }
  return { events, meta: {}, errors: [] };
}

function samePath(a, b) {
  try { return path.resolve(String(a || "")) === path.resolve(String(b || "")); }
  catch { return String(a || "") === String(b || ""); }
}

function findAntigravityConversation(cwd, startMs) {
  // agy records the wrong workspace in history.jsonl (often the launch dir, not our -C)
  // and writes it late, so match the conversation .db by MTIME in the run window instead:
  // agy creates/updates one conversation db per `-p` run.
  const convDir = expandHome("~/.gemini/antigravity-cli/conversations");
  let best = null;
  try {
    for (const f of fs.readdirSync(convDir)) {
      if (!f.endsWith(".db")) continue;
      let st; try { st = fs.statSync(path.join(convDir, f)); } catch { continue; }
      if (st.mtimeMs < startMs - 2000) continue; // not touched during/after our run
      if (!best || st.mtimeMs > best.mtimeMs) best = { id: f.replace(/\.db$/, ""), mtimeMs: st.mtimeMs, timestamp: st.mtimeMs };
    }
  } catch { /* conversations dir missing */ }
  if (best) return best;
  // Fallback: history.jsonl workspace match (when agy happens to record it correctly).
  const historyPath = expandHome("~/.gemini/antigravity-cli/history.jsonl");
  for (const row of readJsonLines(historyPath)) {
    const ts = toMs(row.timestamp);
    if (!row.conversationId || !samePath(row.workspace, cwd) || ts == null || ts < startMs) continue;
    if (!best || ts > best.timestamp) best = { id: row.conversationId, timestamp: ts };
  }
  return best;
}

function copyIfExists(src, dest) {
  try {
    if (fs.existsSync(src)) fs.copyFileSync(src, dest);
  } catch {
    /* best effort; completed agy runs usually checkpoint into the main db */
  }
}

function sqliteJsonRows(dbPath, errors) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-agy-"));
  const copy = path.join(tmp, "conversation.db");
  try {
    fs.copyFileSync(dbPath, copy);
    copyIfExists(dbPath + "-wal", copy + "-wal");
    copyIfExists(dbPath + "-shm", copy + "-shm");
    const sql = [
      "select json_object(",
      "'idx',idx,",
      "'step_type',step_type,",
      "'status',status,",
      "'step_payload',hex(step_payload),",
      "'task_details',hex(task_details),",
      "'metadata',hex(metadata)",
      ") from steps order by idx;"
    ].join("");
    const r = spawnSync("sqlite3", [copy, sql], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) {
      errors.push(`sqlite3 unavailable: ${r.error.message}`);
      return [];
    }
    if (r.status !== 0) {
      errors.push(`sqlite3 failed: ${(r.stderr || "").trim() || `exit ${r.status}`}`);
      return [];
    }
    const rows = [];
    for (const line of String(r.stdout || "").split(/\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); }
      catch (e) { errors.push(`bad sqlite JSON row: ${e.message}`); }
    }
    return rows;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function hexToBuffer(hex) {
  return typeof hex === "string" && hex ? Buffer.from(hex, "hex") : Buffer.alloc(0);
}

function printableStrings(row) {
  const buf = Buffer.concat([
    hexToBuffer(row.step_payload),
    hexToBuffer(row.task_details),
    hexToBuffer(row.metadata),
  ]);
  return buf.toString("latin1").match(PRINTABLE_RE) || [];
}

function extractJsonObjects(text) {
  const out = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === "\"") inString = false;
      } else if (c === "\"") inString = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* not JSON */ }
          break;
        }
      }
    }
  }
  return out;
}

function agyJsonPayloads(strings) {
  const out = [];
  for (const s of strings) {
    if (!s.includes("{")) continue;
    if (!/(TargetFile|CommandLine|CodeContent|toolAction|toolSummary|ArtifactMetadata)/.test(s)) continue;
    out.push(...extractJsonObjects(s));
  }
  return out;
}

function fileUris(text) {
  const out = [];
  const re = /file:\/\/(\/[^\s)"'<>]+)/g;
  let m;
  while ((m = re.exec(text))) {
    let p = m[1].replace(/[.,;:]+$/, "");
    try { p = decodeURIComponent(p); } catch { /* keep raw */ }
    out.push(p);
  }
  return [...new Set(out)];
}

function commandFromParen(text) {
  const m = /\bcommand\(([^)\n]+)\)/.exec(text);
  return m ? m[1].trim() : "";
}

function extractAntigravityAction(row) {
  const strings = printableStrings(row);
  const text = strings.join("\n");
  const payloads = agyJsonPayloads(strings);
  const writePayload = payloads.find((p) => p && (p.TargetFile || p.CodeContent || p.toolSummary || p.toolAction));
  const commandPayload = payloads.find((p) => p && p.CommandLine);

  if ((text.includes("write_to_file") || text.includes("write_file")) && writePayload && (writePayload.TargetFile || writePayload.CodeContent)) {
    const paths = fileUris(text);
    const target = writePayload.TargetFile || paths[0] || "";
    return {
      tool: "write_file",
      params: {
        path: target,
        content: writePayload.CodeContent || "",
        description: writePayload.Description || "",
        toolAction: writePayload.toolAction || "",
        toolSummary: writePayload.toolSummary || "",
        nativeTool: text.includes("write_to_file") ? "write_to_file" : "write_file",
        fileUris: paths,
      },
      command: "",
    };
  }

  if (text.includes("run_command") || commandPayload) {
    const command = (commandPayload && commandPayload.CommandLine) || commandFromParen(text);
    if (!command) return null;
    return {
      tool: "command",
      params: {
        command,
        cwd: commandPayload && commandPayload.Cwd || "",
        toolAction: commandPayload && commandPayload.toolAction || "",
        toolSummary: commandPayload && commandPayload.toolSummary || "",
        nativeTool: "run_command",
      },
      command,
    };
  }

  return null;
}

function antigravityKey(action) {
  const p = action.params || {};
  const basis = action.tool === "command" ? p.command : p.path || p.toolSummary || p.toolAction || p.content || "";
  return `${action.tool}:${crypto.createHash("sha1").update(String(basis)).digest("hex")}`;
}

function harvestAntigravity(cwd, startMs, agent) {
  const errors = [];
  const meta = {};
  const conversation = findAntigravityConversation(cwd, startMs);
  if (!conversation) {
    errors.push(`no Antigravity conversation db modified at or after ${new Date(startMs).toISOString()} (workspace ${cwd})`);
    return { events: [], meta, errors };
  }

  meta.conversationId = conversation.id;
  meta.conversationStarted = new Date(conversation.timestamp).toISOString();
  const dbPath = expandHome(`~/.gemini/antigravity-cli/conversations/${conversation.id}.db`);
  meta.dbPath = dbPath;
  if (!fs.existsSync(dbPath)) {
    errors.push(`Antigravity conversation db not found: ${dbPath}`);
    return { events: [], meta, errors };
  }

  const rows = sqliteJsonRows(dbPath, errors);
  const seen = new Set();
  const events = [];
  for (const row of rows) {
    const action = extractAntigravityAction(row);
    if (!action) continue;
    const key = antigravityKey(action);
    if (seen.has(key)) continue;
    seen.add(key);

    const ts = startMs + num(row.idx) * 10;
    const status = statusFromAgy(row.status);
    events.push({ ts, type: "tool.start", tool: action.tool, params: action.params, agent });
    if (action.tool === "command") {
      events.push({
        ts: ts + 1,
        type: "command",
        command: action.command,
        cwd: action.params.cwd || "",
        status,
        agent,
      });
    }
    if (action.tool === "write_file") {
      events.push({
        ts: ts + 1,
        type: "file.edit",
        tool: "write_file",
        params: {
          path: action.params.path,
          content: action.params.content,
          description: action.params.description,
          toolAction: action.params.toolAction,
          toolSummary: action.params.toolSummary,
        },
        agent,
      });
    }
    events.push({ ts: ts + 2, type: "tool.end", tool: action.tool, status, durationMs: 0, agent });
  }
  meta.steps = rows.length;
  return { events, meta, errors };
}

function readSelfJournal(cwd, startMs) {
  const file = path.join(cwd, "activity.jsonl");
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs < startMs - 1000) return { file, entries: [] };
  } catch {
    return { file, entries: [] };
  }

  const entries = [];
  for (const row of readJsonLines(file)) {
    const ts = toMs(row.ts ?? row.timestamp);
    if (ts != null && ts < startMs) continue;
    const action = String(row.action || row.type || row.tool || "").trim();
    const target = String(row.target || row.path || row.file || row.command || "").trim();
    if (!action && !target) continue;
    entries.push({ ts, action, target });
  }
  return { file, entries };
}

function eventPath(ev) {
  return ev && (ev.path || ev.file || ev.target || (ev.params && (ev.params.path || ev.params.TargetFile)));
}

function nativeActionKey(ev) {
  if (!ev) return null;
  if (ev.type === "file.edit") return `file:${eventPath(ev) || ""}`;
  if (ev.type === "command") return `command:${ev.command || ""}`;
  if (ev.type === "tool.start" && ev.tool && !["write_file", "command"].includes(ev.tool)) {
    return `tool:${ev.tool}:${eventPath(ev) || (ev.params && ev.params.command) || ""}`;
  }
  return null;
}

function selfActionKey(entry) {
  const action = String(entry.action || "").toLowerCase();
  const target = String(entry.target || "");
  if (action.includes("command") || action.includes("shell")) return `command:${target}`;
  if (action.includes("write") || action.includes("edit") || action.includes("file")) return `file:${target}`;
  return `${action}:${target}`;
}

function compareSelfReport(events, journal) {
  const native = [...new Set(events.map(nativeActionKey).filter(Boolean))];
  const self = [...new Set((journal.entries || []).map(selfActionKey).filter(Boolean))];
  const selfTargets = new Set(self.map((k) => k.split(":").slice(1).join(":")));
  const missing = native.filter((k) => {
    if (self.includes(k)) return false;
    const target = k.split(":").slice(1).join(":");
    return !target || !selfTargets.has(target);
  });
  const present = (journal.entries || []).length > 0;
  const large = native.length > 0 && (!present || (missing.length >= 2 && missing.length / native.length >= 0.5));
  return {
    present,
    gap: large,
    nativeActions: native.length,
    selfActions: self.length,
    missingFromSelf: missing.slice(0, 50),
    activityFile: journal.file,
  };
}

function hashEvent(event, prevHash) {
  const linked = { ...event, prevHash };
  const hash = crypto.createHash("sha256").update(JSON.stringify(linked)).digest("hex");
  return { ...linked, hash };
}

function prepareEvents(events, verify) {
  let prevHash = ZERO_HASH;
  return events.map((ev, i) => {
    const withSeq = { seq: i + 1, ...redact(ev) };
    if (!verify) return withSeq;
    const linked = hashEvent(withSeq, prevHash);
    prevHash = linked.hash;
    return linked;
  });
}

function toolNameForRollup(ev) {
  if (ev.tool) return ev.tool;
  if (ev.type === "command") return "command";
  if (ev.type === "file.edit") return "file_edit";
  return null;
}

function buildRollup(events, options) {
  const tools = {};
  const files = new Set();
  let actions = 0, commands = 0, fileChanges = 0, tokensIn = 0, tokensOut = 0, cached = 0, reasoning = 0, turns = 0;
  const hasToolStarts = events.some((ev) => ev.type === "tool.start");

  for (const ev of events) {
    if (ACTION_TYPES.has(ev.type)) actions += 1;
    if (ev.type === "command") commands += 1;
    if (ev.type === "file.edit") fileChanges += 1;
    const tool = toolNameForRollup(ev);
    if (tool && (ev.type === "tool.start" || (!hasToolStarts && (ev.type === "command" || ev.type === "file.edit")))) {
      tools[tool] = (tools[tool] || 0) + 1;
    }
    const p = eventPath(ev);
    if (p) files.add(p);
    if (Array.isArray(ev.params && ev.params.fileUris)) for (const f of ev.params.fileUris) files.add(f);
    if (ev.type === "llm.usage") {
      tokensIn += num(ev.tokensIn);
      tokensOut += num(ev.tokensOut);
      cached += num(ev.cached);
      reasoning += num(ev.reasoning);
      turns += 1;
    }
  }

  const startMs = options.startMs;
  const endMs = options.endMs;
  return redact({
    agent: options.agent,
    actions,
    commands,
    fileChanges,
    tools,
    filesTouched: [...files].sort(),
    tokensIn,
    tokensOut,
    cached,
    reasoning,
    turns,
    durationSec: startMs && endMs && endMs >= startMs ? Math.round((endMs - startMs) / 1000) : null,
    verified: (options.errors || []).length === 0,
    hashChain: !!options.hashChain,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    source: options.meta || {},
    errors: options.errors || [],
    selfReportGap: compareSelfReport(events, options.journal || { entries: [] }),
  });
}

function verifyEnabled() {
  return /^(1|true|yes)$/i.test(process.env.AGENT_BRIDGE_TELEMETRY_VERIFY || "");
}

function harvest(agent, taskdir, cwd, startTs) {
  const startMs = toMs(startTs) || Date.now();
  const endMs = Date.now();
  let tapped = { events: [], meta: {}, errors: [] };
  const errors = [];

  try {
    if (agent === "codex") tapped = harvestCodex(taskdir, startMs, agent);
    else if (agent === "antigravity") tapped = harvestAntigravity(cwd, startMs, agent);
    else tapped = harvestGeneric(taskdir, startMs, agent);
  } catch (e) {
    errors.push(e && e.message ? e.message : String(e));
  }

  errors.push(...(tapped.errors || []));
  const journal = readSelfJournal(cwd, startMs);
  const events = [
    { ts: startMs, type: "agent.start", agent },
    ...(tapped.events || []),
    { ts: endMs, type: "agent.end", agent },
  ];
  const verify = verifyEnabled();
  const prepared = prepareEvents(events, verify);
  fs.writeFileSync(path.join(taskdir, "telemetry.jsonl"), prepared.map((ev) => JSON.stringify(ev)).join("\n") + "\n");

  const rollup = buildRollup(prepared, {
    agent,
    startMs,
    endMs,
    meta: tapped.meta || {},
    errors,
    hashChain: verify,
    journal,
  });
  fs.writeFileSync(path.join(taskdir, "telemetry.json"), JSON.stringify(rollup, null, 2) + "\n");
  return rollup;
}

module.exports = { harvest };
