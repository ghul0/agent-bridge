"use strict";
/**
 * codex-mcp — a minimal MCP (JSON-RPC over stdio) client for a WARM `codex mcp-server`.
 *
 * One long-lived server process holds the conversation; the orchestrator sends prompts
 * and gets responses back over the same channel — no per-turn CLI spawn.
 *   start(prompt)          → { threadId, text, events }   (codex tool)
 *   reply(threadId, prompt)→ { threadId, text, events }   (codex-reply tool)
 * The server streams `codex/event` notifications between call and response; we collect
 * them (for progress/telemetry) and resolve the promise when the tool result arrives.
 *
 * MCP stdio transport = newline-delimited JSON-RPC 2.0 messages.
 */
const { spawn } = require("child_process");

function createCodexServer(opts = {}) {
  const child = spawn("codex", ["mcp-server"], { stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  const pending = new Map();          // id -> {resolve, reject}
  const listeners = [];               // (event) => void  for codex/event notifications
  let queue = Promise.resolve();       // serialize tool calls so event notifications do not mix
  let buf = "";

  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method === "codex/event") {
        for (const fn of listeners) fn(msg.params);
      }
    }
  });
  if (opts.debug) child.stderr.on("data", (d) => process.stderr.write(`[codex-mcp] ${d}`));

  function rejectPending(err) {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  }
  child.on("error", (e) => rejectPending(e));
  child.on("close", (code) => {
    if (pending.size) rejectPending(new Error(`codex mcp-server exited with code ${code}`));
  });

  function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async function initialize() {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-bridge", version: "0.1" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  // Wrap a tool call: collect codex/event notifications until the result returns.
  async function callToolNow(name, args, options = {}) {
    const events = [];
    const collect = (ev) => {
      events.push(ev);
      if (typeof options.onEvent === "function") options.onEvent(ev);
    };
    listeners.push(collect);
    let result;
    try {
      result = await request("tools/call", { name, arguments: args });
    } finally {
      const ix = listeners.indexOf(collect); if (ix >= 0) listeners.splice(ix, 1);
    }
    // threadId lives in structuredContent (post-v0.50); text is the content blocks.
    const sc = result && result.structuredContent;
    const threadId = (sc && (sc.threadId || sc.conversationId)) || null;
    const blockText = ((result && result.content) || [])
      .map((c) => c.text || "").join("").trim();
    const text = blockText || (sc && sc.content) || "";
    return { threadId, text, events, raw: result };
  }
  function callTool(name, args, options) {
    const run = () => callToolNow(name, args, options);
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  return {
    initialize,
    start: (args, options) => callTool("codex", args, options),     // args: {prompt, cwd, sandbox, ...}
    reply: (threadId, prompt, options) => callTool("codex-reply", { threadId, prompt }, options),
    onEvent: (fn) => listeners.push(fn),
    close: () => { try { child.stdin.end(); child.kill(); } catch { /* ok */ } },
    child,
  };
}

module.exports = { createCodexServer };
