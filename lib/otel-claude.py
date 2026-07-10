#!/usr/bin/env python3
"""otel-claude — a tiny local OTLP/HTTP receiver for Claude Code metrics.

Claude Code emits an OpenTelemetry counter `claude_code.token.usage` (attributes:
`type` = input|output|cacheRead|cacheCreation, `model`, and resource attr
`session.id`). Point Claude Code at this receiver and it records Claude's own
token, cost, and lines-of-code telemetry into the same relay.db, so `relay.py
tokens` and the dashboard can show Claude vs delegated agents.

Run it (background terminal):
    python3 otel-claude.py            # listens on http://localhost:4318

Then start Claude Code with telemetry on (see README). No external services.
"""
import json, os, sqlite3, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = os.environ.get("RELAY_DB", os.path.expanduser("~/.agent-bridge/relay.db"))
PORT = int(os.environ.get("OTEL_PORT", "4318"))
TOKEN_METRIC = "claude_code.token.usage"
UNKNOWN_SESSION = "(unknown)"


def db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    c = sqlite3.connect(DB, timeout=30)
    c.execute("PRAGMA busy_timeout=30000")
    c.execute("""CREATE TABLE IF NOT EXISTS claude_tokens(
        model TEXT, type TEXT, tokens INTEGER, updated REAL, PRIMARY KEY(model,type))""")
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


def _attrs(obj):
    out = {}
    for a in obj.get("attributes", []):
        v = a.get("value", {})
        out[a.get("key")] = (v.get("stringValue") or v.get("intValue") or
                             v.get("doubleValue") or v.get("boolValue"))
    return out


def _val(dp):
    if "asInt" in dp:
        return float(dp["asInt"])
    if "asDouble" in dp:
        return float(dp["asDouble"])
    return 0


def _points(metric):
    return (metric.get("sum") or metric.get("gauge") or {}).get("dataPoints", [])


def _metric_kind(name):
    name = (name or "").lower()
    if name == TOKEN_METRIC or ("token" in name and "usage" in name):
        return "token"
    if "cost" in name and "usage" in name:
        return "cost"
    if ("lines_of_code" in name or ".loc." in name or name.endswith(".loc")) and "count" in name:
        return "loc"
    return ""


def ingest(payload):
    """Walk an OTLP ExportMetricsServiceRequest (JSON) and upsert telemetry."""
    rows = 0
    c = db()
    for rm in payload.get("resourceMetrics", []):
        resource_attrs = _attrs(rm.get("resource", {}))
        for sm in rm.get("scopeMetrics", []):
            for m in sm.get("metrics", []):
                kind = _metric_kind(m.get("name"))
                if not kind:
                    continue
                for dp in _points(m):
                    at = {**resource_attrs, **_attrs(dp)}
                    session_id = at.get("session.id") or at.get("session_id") or UNKNOWN_SESSION
                    model = at.get("model") or resource_attrs.get("model") or "claude"
                    value = _val(dp)
                    now = time.time()

                    if kind == "token":
                        typ = at.get("type", "unknown")
                        tokens = int(value)
                        # Counter is cumulative per process: keep the max we've seen.
                        c.execute(
                            """INSERT INTO claude_tokens(model,type,tokens,updated)
                               VALUES(?,?,?,?)
                               ON CONFLICT(model,type) DO UPDATE SET
                                 tokens=MAX(tokens, excluded.tokens), updated=excluded.updated""",
                            (model, typ, tokens, now))
                        c.execute(
                            """INSERT INTO claude_usage(session_id,model,type,tokens,updated)
                               VALUES(?,?,?,?,?)
                               ON CONFLICT(session_id,model,type) DO UPDATE SET
                                 tokens=MAX(tokens, excluded.tokens), updated=excluded.updated""",
                            (session_id, model, typ, tokens, now))
                    elif kind == "cost":
                        c.execute(
                            """INSERT INTO claude_cost(session_id,model,cost_usd,updated)
                               VALUES(?,?,?,?)
                               ON CONFLICT(session_id,model) DO UPDATE SET
                                 cost_usd=MAX(cost_usd, excluded.cost_usd), updated=excluded.updated""",
                            (session_id, model, float(value), now))
                    elif kind == "loc":
                        typ = at.get("type", "unknown")
                        c.execute(
                            """INSERT INTO claude_loc(session_id,type,lines,updated)
                               VALUES(?,?,?,?)
                               ON CONFLICT(session_id,type) DO UPDATE SET
                                 lines=MAX(lines, excluded.lines), updated=excluded.updated""",
                            (session_id, typ, int(value), now))
                    rows += 1
    c.commit(); c.close()
    return rows


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _ok(self, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/v1/metrics"):
            return self._ok(404)
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n)
        try:
            got = ingest(json.loads(raw.decode("utf-8")))
            if got:
                sys.stderr.write(f"[otel-claude] recorded {got} claude metric datapoint(s)\n")
        except Exception as e:  # never 500 the exporter
            sys.stderr.write(f"[otel-claude] parse error: {e}\n")
        self._ok()


if __name__ == "__main__":
    print(f"otel-claude listening on http://localhost:{PORT}  →  {DB}")
    print("Set Claude Code env (see README), then restart it. Ctrl-C to stop.")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
