# Claude Code OTEL — verified metric spec (for finalizing otel-claude.py)

Confirmed against official docs (code.claude.com/docs/en/monitoring-usage.md). Use these
exact names when extending `lib/otel-claude.py` (spec §4) and the setup env.

## Enable (Claude Code side) — note the export interval!
```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json          # our receiver parses http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_METRIC_EXPORT_INTERVAL=5000               # CRITICAL: default is 60000 (60s) — too slow for a live dashboard
export OTEL_METRICS_INCLUDE_SESSION_ID=true           # default true; needed for per-session grouping
```

## Metrics (all counters, cumulative)
| metric | key attributes |
|--------|----------------|
| `claude_code.token.usage`      | `type` = input \| output \| cacheRead \| cacheCreation ; `model` |
| `claude_code.cost.usage`       | `model`, `query_source`, `speed`, `agent.name`, `skill.name` |
| `claude_code.lines_of_code.count` | `type` = added \| removed |
| `claude_code.session.count`    | `start_type` |
| `claude_code.commit.count`     | (standard only) |
| `claude_code.pull_request.count` | (standard only) |
| `claude_code.active_time.total`  | `type` = user \| cli |

## Standard/resource attributes (on every metric)
`session.id`, `user.id`, `user.email`, `user.account_uuid`, `organization.id`,
`app.version`, `app.entrypoint`. `session.id` may live at resource level (resourceMetrics
→ resource → attributes) OR as a data-point attribute — the receiver should check both.

## Notes
- cache token type values are **camelCase** (`cacheRead`, `cacheCreation`).
- Values arrive as `asInt` or `asDouble`; handle `sum` and `gauge` data-point shapes.
- Counters are cumulative → upsert MAX per (session.id, model, type).
