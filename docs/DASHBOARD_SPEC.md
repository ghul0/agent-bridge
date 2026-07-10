# agent-bridge telemetry dashboard — build spec

Build a **local browser dashboard** that visualizes usage/telemetry across Claude and the
delegated agents (Codex, Gemini). Dark, warm/orange "Anthropic" aesthetic. The value: a
team can see where tokens, turns, and cost go **across all agents in one place** — Claude
Code's own telemetry can't see Codex/Gemini, so unifying them is the differentiator.

Started via `agent-bridge dashboard` → prints a `http://localhost:PORT` URL.

---

## 0. Constraints & conventions
- **Pure Node stdlib** for the server (`http`, `fs`, `child_process`) — NO npm dependencies.
- The HTML page is **fully self-contained**: inline CSS + JS, hand-rolled SVG charts, no
  CDNs, no external fonts/scripts. (System fonts only.)
- Read data live on each request; the page auto-refreshes. No build step.
- Node ≥ 18 (target the installed Node 24). Do not use `node:sqlite` (avoid the
  experimental warning) — get Claude token data by exec-ing the Python helper (§3).
- Timestamps: ISO-8601 UTC. Money: USD, 2 decimals. Big token counts: thousands separators.
- Keep it lean and readable; match the existing code style in `lib/` (2-space indent,
  `"use strict"`, small focused functions).

---

## 1. Data sources

### 1a. Filesystem — the agent tasks (authoritative for Codex/Gemini)
Root: `~/.agent-bridge/tasks/<id>/` (honor `AGENT_BRIDGE_HOME` env like `lib/fslog.js`).
Reuse `lib/fslog.js` helpers (`listTasks`, `parse`, `readStatus`, `taskDir`).
Per task:
- `task.md` frontmatter: `task, agent, cwd, sandbox, created, finished, status, usage`
  (`usage` is a JSON string of the last turn: `{input_tokens, output_tokens,
  cached_input_tokens, reasoning_output_tokens}` — may be empty).
- `status.md` frontmatter: `status` (queued|working|blocked|done|error), `progress`,
  `updated`, `summary`, `needs_input`.
- `events.jsonl`: one JSON per line (the agent's raw event stream). Derive:
  - **turns** = count of lines where `type === "turn.completed"` (codex) — for gemini be
    tolerant (count final/assistant terminal events); if unknown, `turns = null`.
  - **total tokens** = SUM over all `turn.completed.usage` (not just the last), fields
    `input_tokens/output_tokens/cached_input_tokens/reasoning_output_tokens`.
  - **commands** = count of `command_execution` items; **fileChanges** = count of
    `file_change` items (best-effort; tolerate missing).
- `result.md`: final text (for the detail drawer).

### 1b. relay.db — Claude's own usage (via the OTEL receiver)
Claude Code emits OpenTelemetry metrics; `lib/otel-claude.py` receives them into a SQLite
DB. Table `claude_tokens(model, type, tokens, updated)` exists today (types: input,
output, cacheRead, cacheCreation). **Extend** per §4 to also capture cost + session id.
The dashboard reads this by exec-ing `python3 lib/relay.py export` (§3), never by opening
the DB directly.

> Path note: make the OTEL receiver and the dashboard use the SAME db. In
> `bin/agent-bridge.js`, set `RELAY_DB=$AGENT_BRIDGE_HOME/relay.db` (default
> `~/.agent-bridge/relay.db`) in the env for the `otel` and `dashboard` subcommands so
> both agree. Keep `~` expansion working.

---

## 2. New / changed files
- `bin/agent-bridge.js` — add `dashboard [--port <n>] [--open]` (default port 7676).
  Start the server, print the URL, and if `--open`, open it (`open` on macOS, `xdg-open`
  on Linux). Also export `RELAY_DB` for `otel` + `dashboard` as noted above.
- `lib/dashboard.js` — the HTTP server + the JSON API + the HTML (HTML may be a template
  string in this file, or a sibling `lib/dashboard.html` read at startup — your call, keep
  it self-contained).
- `lib/relay.py` — add an `export` subcommand (§3).
- `lib/otel-claude.py` — extend to capture cost + session id + LOC (§4).
- `README.md` — a short "Dashboard" section.

---

## 3. `relay.py export` (JSON bridge for Claude data)
Add subcommand `export` that prints ONE JSON object to stdout:
```json
{
  "claude_tokens": [ {"model":"claude-opus-4-8","type":"input","tokens":45000}, ... ],
  "claude_sessions": [ {"session_id":"abc","model":"claude-opus-4-8","input":N,"output":N,
                        "cacheRead":N,"cacheCreation":N,"cost_usd":0.42,
                        "lines_added":N,"lines_removed":N,"updated":"..."} ]
}
```
`claude_sessions` may be empty if the extended tables aren't populated yet. Never error if
tables are missing — return empty arrays.

---

## 4. Extend `otel-claude.py` (SHOULD — do after the dashboard renders)
Claude Code metrics to capture (confirm exact names against Claude Code's monitoring docs;
be defensive — tolerate missing attrs and metric-name variants):
- `claude_code.token.usage` — attrs `type` (input|output|cacheRead|cacheCreation), `model`,
  and the resource attr `session.id`. Keep the existing `claude_tokens` upsert AND also
  upsert into a new `claude_usage(session_id, model, type, tokens, updated)` (PK
  session_id+model+type, keep MAX — counter is cumulative).
- `claude_code.cost.usage` — attrs `model`, `session.id`. Store into
  `claude_cost(session_id, model, cost_usd, updated)` (keep MAX).
- `claude_code.lines_of_code.count` — attr `type` (added|removed). Store into
  `claude_loc(session_id, type, lines, updated)` (keep MAX). Session id optional.
`relay.py export`'s `claude_sessions` joins these by session_id. If `session.id` isn't
present on a data point, bucket under `"(unknown)"`.

Handle both OTLP `sum` and `gauge` data-point shapes; values in `asInt` or `asDouble`.

---

## 5. HTTP API (server → page)
- `GET /` → the HTML page.
- `GET /api/summary` →
  ```json
  {
    "totals": {"tokensIn":N,"tokensOut":N,"cached":N,"reasoning":N,"costUsd":N,
               "tasks":N,"failures":N,"avgTurns":N,"cacheHitPct":N},
    "byAgent": [ {"agent":"claude","tokensIn":N,"tokensOut":N,"cached":N,"costUsd":N,"share":0.62},
                 {"agent":"codex", ...}, {"agent":"gemini", ...} ],
    "series": [ {"date":"2026-07-09","claude":N,"codex":N,"gemini":N} ]   // total tokens/agent/day
  }
  ```
  - `share` = agent's (in+out) / grand total (in+out). `cacheHitPct` = cached /
    (input incl. cached) across agents. `avgTurns` = mean turns over tasks with a turn count.
    `failures` = tasks with status error|blocked.
  - Claude's row: from `claude_tokens` (in = input+cacheRead+cacheCreation, out = output);
    cost from `claude_cost` sum if present.
- `GET /api/sessions` → array, newest first:
  ```json
  [{"id","agent","repo","cwd","status","progress","createdIso","finishedIso",
    "durationSec","turns","commands","fileChanges","tokensIn","tokensOut","cached",
    "reasoning","costUsd","summary"}]
  ```
  `repo` = basename of `cwd`. `durationSec` = finished-created (or updated-created if
  still running). `costUsd` = estimated (§6), may be 0.
- `GET /api/task/:id` →
  ```json
  {"frontmatter":{...task.md...}, "status":{...status.md fields...}, "statusBody":"...",
   "result":"...", "events":[{"ts":null,"kind":"command_execution","text":"..."}...]}
  ```
  (events: map each events.jsonl line through a light summarizer; cap at ~200 lines.)

Return `application/json`; on error return `{error}` with 500, never crash the server.

---

## 6. Cost estimation (best-effort, configurable)
Add `lib/pricing.json` — a map of model-name substring → `{inPerM, cachedPerM, outPerM}`
in USD per 1M tokens. Seed with editable DEFAULTS (mark clearly as estimates the user
should adjust), e.g.:
```json
{ "opus":   {"inPerM":15, "cachedPerM":1.5, "outPerM":75},
  "sonnet": {"inPerM":3,  "cachedPerM":0.3, "outPerM":15},
  "haiku":  {"inPerM":0.8,"cachedPerM":0.08,"outPerM":4},
  "codex":  {"inPerM":0,  "cachedPerM":0,   "outPerM":0},
  "gpt":    {"inPerM":0,  "cachedPerM":0,   "outPerM":0},
  "gemini": {"inPerM":0,  "cachedPerM":0,   "outPerM":0},
  "default":{"inPerM":0,  "cachedPerM":0,   "outPerM":0} }
```
Match by substring on the model id; codex/gemini default to 0 (subscription) — show cost
as "est." and note in the UI that it's editable in `pricing.json`. For Claude, prefer the
real `claude_code.cost.usage` when available over the estimate.

---

## 7. UI spec — dark, warm/orange (Anthropic feel)

### Palette (use these exact tokens as CSS variables)
```
--bg:        #1A1712   (warm near-black)
--surface:   #221E17
--surface-2: #2A251C   (elevated cards / drawer)
--border:    #3A3329
--text:      #F0EADE   (warm ivory, primary)
--text-2:    #B8AF9F   (secondary)
--muted:     #857C6D
--accent:    #D97757   (Anthropic clay/coral — primary)
--accent-br: #E8916B   (bright hover/active)
--good:      #6FBF8B   (done / positive)
--warn:      #E0A44E   (working / caution)
--bad:       #D9615A   (error)
Agent category colors:  claude #D97757 · codex #E0A44E · gemini #8B9DC9
Status badges: done→--good, working→--warn, blocked→#D98A3D, error→--bad, queued→--muted
```
Backgrounds warm and dark; accent orange used for the logo dot, primary numbers' underline,
active states, and the Claude series. Keep it tasteful — orange as accent, not everywhere.

### Type
- Big numbers & section headers: `ui-serif, Georgia, 'Times New Roman', serif` (editorial).
- Body / labels / table: `system-ui, -apple-system, 'Segoe UI', sans-serif`.
- IDs / token counts / code: `ui-monospace, 'SF Mono', Menlo, monospace`.
- Section labels: small, uppercase, letter-spaced, `--muted`.

### Layout (single page, max-width ~1280px, centered, generous padding)
1. **Header bar** — left: an orange dot + "agent-bridge" (serif) + "telemetry" (muted).
   Right: a green pulsing "live" dot, "updated Xs ago", and a refresh interval toggle
   (4s default; allow pause).
2. **KPI row** — 6 stat tiles in a responsive grid. Each tile: uppercase muted label,
   big serif value, small sub-context line. Tiles:
   Total tokens · Est. cost (USD) · Tasks run · Avg turns/task · Cache-hit % · Failure %.
   (Give the tiles a subtle top accent border in the relevant color.)
3. **Two-panel row**:
   - **Token share by agent** — a hand-rolled SVG **donut** (Claude/Codex/Gemini) with a
     center total, plus a legend with % and absolute tokens. Segment colors = agent colors.
   - **Tokens over time** — hand-rolled SVG **stacked bar chart** by day (x = date, y =
     tokens, stacked by agent). Hover tooltip with the day's breakdown. If only one day of
     data, bucket by hour.
4. **Sessions table** — columns: Time · Agent (color chip + name) · Task (mono id,
   truncated, click to open) · Repo · Status (badge) · Turns · In · Out · Cached · Dur.
   Sortable by clicking headers. Newest first by default. Zebra rows on `--surface`.
   A running task shows a thin progress bar under its row (from `progress`).
5. **Detail drawer** (slides in from the right when a task row is clicked) — shows the
   task's `summary`, a rendered view of `status.md` (Done/Next), `result.md`, and a compact
   **events timeline** (each command_execution / agent_message / file_change as a row with
   its kind chip). A close button + click-outside to dismiss. If `needs_input` is set,
   show a prominent amber "⚠ agent is asking Claude: …" banner at the top.

### Behavior
- Poll `/api/summary` and `/api/sessions` every 4s; update the DOM in place (don't reflow
  the whole page — diff/replace tile values and table rows). Pause toggle stops polling.
- Empty states: friendly "No tasks yet — run `agent-bridge run --agent codex …`" message.
- Charts must degrade gracefully with 0/1 data points.

### Accessibility
- AA contrast on the dark bg. Never encode meaning by color alone — badges and legends
  carry text/%. Focusable rows/toggles with visible focus rings. `aria-label`s on charts
  and the live indicator. Respect `prefers-reduced-motion` (disable the pulse/slide).

---

## 8. Acceptance criteria (Codex: verify each before finishing)
1. `agent-bridge dashboard` starts a server and prints a working `http://localhost:PORT` URL.
2. Visiting `/` renders the dark/orange dashboard with the KPI row, both charts, and the
   sessions table populated from the REAL `~/.agent-bridge/tasks/` data (there is at least
   one real task there now — it must appear).
3. `/api/summary` and `/api/sessions` return valid JSON matching §5; `curl` them and confirm.
4. Clicking a task row opens the drawer showing its status.md, result.md, and events.
5. The page auto-refreshes (new tasks appear within ~4s without a manual reload).
6. `relay.py export` prints valid JSON (empty arrays are fine if no Claude data yet).
7. No external network requests from the page (fully self-contained); no npm deps added.
8. `node -c lib/dashboard.js` passes; `agent-bridge doctor` still works.
Prioritize 1–5 (MUST). §4 (extended OTEL) is SHOULD — implement it, but if time is tight,
ensure the dashboard renders correctly with Claude shown as an aggregate from `claude_tokens`.

## 9. Update the work-log as you go
Per the agent-bridge protocol, overwrite this task's `status.md` at intervals with your
progress (status/progress/summary), and write a final `result.md` listing what you built,
the exact command to launch it, and any follow-ups.
