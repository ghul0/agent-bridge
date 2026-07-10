#!/usr/bin/env python3
"""relay — a shared SQLite message bus between Claude and Codex.

Every message and every telemetry event is one row, so the bus IS the
observability store. Both agents talk to it over this CLI:
  - Claude has Bash; Codex has a shell in workspace-write mode.

Subcommands:
  send    append a message              (--from --to --kind --body ...)
  poll    read + mark unread for a recipient   (--to claude|codex)
  tail    unified timeline, most recent last    (--follow)
  wait    block until a reply to a given id arrives  (--ref ID)
  ingest  read `codex exec --json` JSONL on stdin, log each event
  export  print Claude telemetry JSON for the dashboard
  stats   counts + token totals
  init    create the db

DB path: $RELAY_DB or ~/.agent-bridge/relay.db
"""
import argparse, json, os, sqlite3, sys, time
from datetime import datetime, timezone

DB = os.environ.get("RELAY_DB", os.path.expanduser("~/.agent-bridge/relay.db"))
KINDS = ("dispatch", "event", "msg", "ask", "reply", "note", "done", "error")


def conn():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    c = sqlite3.connect(DB, timeout=30)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=30000")
    c.execute("""CREATE TABLE IF NOT EXISTS messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL, trace TEXT, sender TEXT, recipient TEXT,
        kind TEXT, ref INTEGER, body TEXT, meta TEXT, read INTEGER DEFAULT 0)""")
    # Claude-side token totals, fed by the OTEL receiver (otel-claude.py).
    # Cumulative-per-process, so we upsert the latest value per (model,type).
    c.execute("""CREATE TABLE IF NOT EXISTS claude_tokens(
        model TEXT, type TEXT, tokens INTEGER, updated REAL,
        PRIMARY KEY(model,type))""")
    c.execute("""CREATE TABLE IF NOT EXISTS claude_usage(
        session_id TEXT, model TEXT, type TEXT, tokens INTEGER, updated REAL,
        PRIMARY KEY(session_id,model,type))""")
    c.execute("""CREATE TABLE IF NOT EXISTS claude_cost(
        session_id TEXT, model TEXT, cost_usd REAL, updated REAL,
        PRIMARY KEY(session_id,model))""")
    c.execute("""CREATE TABLE IF NOT EXISTS claude_loc(
        session_id TEXT, type TEXT, lines INTEGER, updated REAL,
        PRIMARY KEY(session_id,type))""")
    return c


def _row(r):
    keys = ("id", "ts", "trace", "sender", "recipient", "kind", "ref", "body", "meta", "read")
    return dict(zip(keys, r))


def cmd_init(a):
    conn().close()
    print(f"relay db ready at {DB}")


def cmd_send(a):
    c = conn()
    cur = c.execute(
        "INSERT INTO messages(ts,trace,sender,recipient,kind,ref,body,meta,read) VALUES(?,?,?,?,?,?,?,?,0)",
        (time.time(), a.trace, getattr(a, "from"), a.to, a.kind, a.ref, a.body, a.meta),
    )
    c.commit()
    mid = cur.lastrowid
    c.close()
    print(mid if a.quiet else f"[#{mid}] {getattr(a,'from')} → {a.to} ({a.kind}): {a.body or ''}")
    return mid


def cmd_poll(a):
    c = conn()
    q = "SELECT * FROM messages WHERE recipient IN (?, 'all') AND read=0"
    args = [a.to]
    if a.since:
        q += " AND id>?"; args.append(a.since)
    q += " ORDER BY id"
    rows = c.execute(q, args).fetchall()
    if not a.peek and rows:
        ids = [r[0] for r in rows]
        c.execute(f"UPDATE messages SET read=1 WHERE id IN ({','.join('?'*len(ids))})", ids)
        c.commit()
    c.close()
    if a.json:
        print(json.dumps([_row(r) for r in rows]))
    else:
        for r in rows:
            d = _row(r)
            print(f"[#{d['id']}] {d['sender']} ({d['kind']}): {d['body'] or ''}")
        if not rows and not a.quiet:
            print("(nothing new)")


def _fmt(d):
    ts = time.strftime("%H:%M:%S", time.localtime(d["ts"]))
    arrow = f"{d['sender']}→{d['recipient']}"
    tr = f" {d['trace'][:8]}" if d["trace"] else ""
    body = (d["body"] or "").replace("\n", " ")
    if len(body) > 200:
        body = body[:200] + "…"
    return f"{ts}{tr} [{d['kind']:8}] {arrow:15} {body}"


def cmd_tail(a):
    seen = 0
    while True:
        c = conn()
        q = "SELECT * FROM messages"
        args = []
        conds = []
        if a.trace:
            conds.append("trace=?"); args.append(a.trace)
        if seen:
            conds.append("id>?"); args.append(seen)
        if conds:
            q += " WHERE " + " AND ".join(conds)
        q += " ORDER BY id DESC LIMIT ?" if not seen else " ORDER BY id"
        if not seen:
            args.append(a.n)
        rows = c.execute(q, args).fetchall()
        c.close()
        if not seen:
            rows = list(reversed(rows))
        for r in rows:
            d = _row(r); print(_fmt(d)); seen = max(seen, d["id"])
        if not a.follow:
            break
        time.sleep(1)


def cmd_wait(a):
    deadline = time.time() + a.timeout
    while time.time() < deadline:
        c = conn()
        r = c.execute(
            "SELECT * FROM messages WHERE ref=? AND kind IN ('reply','done','error') ORDER BY id LIMIT 1",
            (a.ref,),
        ).fetchone()
        c.close()
        if r:
            d = _row(r)
            print(d["body"] or "")
            sys.exit(0 if d["kind"] != "error" else 1)
        time.sleep(a.interval)
    sys.stderr.write(f"timeout waiting for reply to #{a.ref}\n")
    sys.exit(2)


def cmd_ingest(a):
    """Read codex `--json` JSONL from stdin; log each event as an 'event' row."""
    c = conn()
    final, usage = None, None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = ev.get("type", "")
        summary, kind = t, "event"
        if t == "item.completed":
            it = ev.get("item", {})
            itype = it.get("type", "item")
            text = it.get("text") or it.get("message") or it.get("command") or ""
            summary = f"{itype}: {text}"[:400]
            if itype == "agent_message":
                final = it.get("text")
        elif t == "turn.completed":
            usage = ev.get("usage")
            summary = f"turn done · {usage}"
        c.execute(
            "INSERT INTO messages(ts,trace,sender,recipient,kind,ref,body,meta,read) VALUES(?,?,?,?,?,?,?,?,1)",
            (time.time(), a.trace, a.__dict__["from"], "claude", kind, None, summary, line),
        )
        c.commit()  # per-event: don't hold a write lock for the whole run
    c.close()
    # Emit final message + usage so the caller can capture them
    out = {"final": final, "usage": usage}
    print(json.dumps(out))


def cmd_stats(a):
    c = conn()
    print("by kind:")
    for k, n in c.execute("SELECT kind,COUNT(*) FROM messages GROUP BY kind ORDER BY 2 DESC"):
        print(f"  {k:10} {n}")
    print("by sender:")
    for s, n in c.execute("SELECT sender,COUNT(*) FROM messages GROUP BY sender"):
        print(f"  {s:10} {n}")
    tin = tout = 0
    for (meta,) in c.execute("SELECT meta FROM messages WHERE meta LIKE '%usage%'"):
        try:
            u = json.loads(meta).get("usage") or {}
            tin += u.get("input_tokens", 0); tout += u.get("output_tokens", 0)
        except Exception:
            pass
    print(f"tokens: in={tin} out={tout}")
    c.close()


def cmd_tokens(a):
    """Claude-vs-Codex token accounting per trace (session) + totals.

    Codex usage comes from its `turn.completed` events (already captured).
    Claude usage comes from rows written by the OTEL bridge (sender='claude',
    kind='usage') — see otel-claude.py. If none present, Claude shows as n/a.
    """
    c = conn()
    codex = {}  # trace -> {in,out,cached,reasoning}
    for trace, meta in c.execute(
        "SELECT trace, meta FROM messages WHERE meta LIKE '%turn.completed%'"):
        try:
            u = json.loads(meta).get("usage") or {}
        except Exception:
            continue
        d = codex.setdefault(trace or "(none)", dict(inp=0, out=0, cached=0, reasoning=0))
        d["inp"] += u.get("input_tokens", 0); d["out"] += u.get("output_tokens", 0)
        d["cached"] += u.get("cached_input_tokens", 0); d["reasoning"] += u.get("reasoning_output_tokens", 0)
    cl_in = cl_out = 0  # Claude side: input-ish (input+cacheRead+cacheCreation) vs output
    for typ, tok in c.execute("SELECT type, SUM(tokens) FROM claude_tokens GROUP BY type"):
        if typ == "output":
            cl_out += tok or 0
        else:  # input, cacheRead, cacheCreation
            cl_in += tok or 0
    c.close()

    print(f"{'trace':14} {'agent':7} {'in':>10} {'out':>9} {'cached':>10} {'reason':>8}")
    print("─" * 62)
    ct_in = ct_out = 0
    for tr in sorted(codex):
        cx = codex[tr]
        print(f"{tr[:12]:14} {'codex':7} {cx['inp']:>10} {cx['out']:>9} {cx['cached']:>10} {cx['reasoning']:>8}")
        ct_in += cx["inp"]; ct_out += cx["out"]
    print("─" * 62)
    print(f"{'TOTAL':14} {'codex':7} {ct_in:>10} {ct_out:>9}")
    if cl_in or cl_out:
        print(f"{'':14} {'claude':7} {cl_in:>10} {cl_out:>9}")
        ct = ct_in + ct_out; cl = cl_in + cl_out
        print(f"\nSplit this session:  Codex {100*ct/max(1,ct+cl):.0f}%  ·  "
              f"Claude {100*cl/max(1,ct+cl):.0f}%   (of {ct+cl:,} total tokens)")
    else:
        print("\nClaude-side tokens: n/a — start the OTEL receiver + restart Claude Code "
              "with telemetry on (see README → 'Token accounting').")


def _iso(ts):
    if not ts:
        return ""
    return datetime.fromtimestamp(float(ts), timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _has_table(c, name):
    return c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def _readonly_conn():
    if not os.path.exists(DB):
        return None
    try:
        return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    except sqlite3.Error:
        return None


def _session_row(session_id, model):
    return {
        "session_id": session_id or "(unknown)",
        "model": model or "claude",
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheCreation": 0,
        "cost_usd": 0,
        "lines_added": 0,
        "lines_removed": 0,
        "_updated": 0,
    }


def cmd_export(a):
    """Print one JSON object for the Node dashboard. Missing tables are tolerated."""
    out = {"claude_tokens": [], "claude_sessions": []}
    c = _readonly_conn()
    if c is None:
        print(json.dumps(out))
        return
    try:
        if _has_table(c, "claude_tokens"):
            for model, typ, tokens, updated in c.execute(
                    "SELECT model,type,tokens,updated FROM claude_tokens ORDER BY model,type"):
                out["claude_tokens"].append({
                    "model": model or "claude",
                    "type": typ or "unknown",
                    "tokens": tokens or 0,
                    "updated": _iso(updated),
                })

        sessions = {}
        if _has_table(c, "claude_usage"):
            for session_id, model, typ, tokens, updated in c.execute(
                    "SELECT session_id,model,type,tokens,updated FROM claude_usage"):
                key = (session_id or "(unknown)", model or "claude")
                d = sessions.setdefault(key, _session_row(*key))
                if typ in ("input", "output", "cacheRead", "cacheCreation"):
                    d[typ] = tokens or 0
                d["_updated"] = max(d["_updated"], updated or 0)

        if _has_table(c, "claude_cost"):
            for session_id, model, cost_usd, updated in c.execute(
                    "SELECT session_id,model,cost_usd,updated FROM claude_cost"):
                key = (session_id or "(unknown)", model or "claude")
                d = sessions.setdefault(key, _session_row(*key))
                d["cost_usd"] = cost_usd or 0
                d["_updated"] = max(d["_updated"], updated or 0)

        loc = {}
        if _has_table(c, "claude_loc"):
            for session_id, typ, lines, updated in c.execute(
                    "SELECT session_id,type,lines,updated FROM claude_loc"):
                sid = session_id or "(unknown)"
                d = loc.setdefault(sid, {"added": 0, "removed": 0, "_updated": 0})
                if typ in ("added", "removed"):
                    d[typ] = lines or 0
                d["_updated"] = max(d["_updated"], updated or 0)

        for (session_id, _model), d in sessions.items():
            l = loc.get(session_id, {})
            d["lines_added"] = l.get("added", 0)
            d["lines_removed"] = l.get("removed", 0)
            d["_updated"] = max(d["_updated"], l.get("_updated", 0))
            d["updated"] = _iso(d.pop("_updated", 0))
            out["claude_sessions"].append(d)
        out["claude_sessions"].sort(key=lambda x: x.get("updated") or "", reverse=True)
    finally:
        c.close()
    print(json.dumps(out))


def main():
    p = argparse.ArgumentParser(prog="relay")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send"); s.set_defaults(fn=cmd_send)
    s.add_argument("--from", required=True); s.add_argument("--to", required=True)
    s.add_argument("--kind", default="msg", choices=KINDS)
    s.add_argument("--body", default=""); s.add_argument("--trace", default="")
    s.add_argument("--ref", type=int); s.add_argument("--meta", default="")
    s.add_argument("--quiet", action="store_true")

    s = sub.add_parser("poll"); s.set_defaults(fn=cmd_poll)
    s.add_argument("--to", required=True); s.add_argument("--since", type=int)
    s.add_argument("--peek", action="store_true"); s.add_argument("--json", action="store_true")
    s.add_argument("--quiet", action="store_true")

    s = sub.add_parser("tail"); s.set_defaults(fn=cmd_tail)
    s.add_argument("-n", type=int, default=30); s.add_argument("--follow", action="store_true")
    s.add_argument("--trace", default="")

    s = sub.add_parser("wait"); s.set_defaults(fn=cmd_wait)
    s.add_argument("--ref", type=int, required=True); s.add_argument("--timeout", type=float, default=300)
    s.add_argument("--interval", type=float, default=2)

    s = sub.add_parser("ingest"); s.set_defaults(fn=cmd_ingest)
    s.add_argument("--from", default="codex"); s.add_argument("--trace", default="")

    sub.add_parser("stats").set_defaults(fn=cmd_stats)
    sub.add_parser("tokens").set_defaults(fn=cmd_tokens)
    sub.add_parser("export").set_defaults(fn=cmd_export)
    sub.add_parser("init").set_defaults(fn=cmd_init)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
