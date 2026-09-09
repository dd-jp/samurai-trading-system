# Tech Stack

Locked-in choices, versions, and rationale. Update as stack crystallizes.

---

## Runtime / Language

| Layer | Choice | Why |
|-------|--------|-----|
| Primary | TypeScript | Owner's main language (React/TS). Ecosystem for websockets, ccxt, IBKR wrappers all mature. |
| Alternative considered | Python | Strong quant ecosystem (pandas, numpy, TA-lib), but owner's stack is TS. Would force language switch for a solo project. |
| Alternative considered | Rust/Go | Performance gain marginal vs complexity cost for 50-100 trades/day. Not justified here. |

## Market Data

| Component | Choice | Why |
|-----------|--------|-----|
| MVP source | Alpaca (historical bars + streaming quotes) | ADR-0001: first end-to-end path, covers the default universe (SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD) in one account. |
| Crypto feed (long-term) | ccxt + WebSocket | Unified API across exchanges. Swap from Kraken to Coinbase = config change, not code rewrite. |
| Stock feed (long-term) | IBKR TWS streaming | Only UK-accessible broker with API + streaming. |
| Scheduling | Orchestrator tick loop (fixed interval crypto; market-hours-gated stocks) | See orchestrator-spec.md — resolved, not TBD. |

## Brokers / Execution

| Layer | Choice | Why |
|-------|--------|-----|
| MVP | Alpaca (paper first) | ADR-0001: simplest paper setup, native bracket/OCO support, proves the architecture end-to-end before bolting on ccxt/IBKR. |
| Crypto (long-term) | Kraken or Coinbase Advanced via ccxt | Simpler API, 24/7, fastest feedback loop once the architecture is proven. |
| Stocks (long-term) | Interactive Brokers (IBKR); Freetrade/Trading212 for live equities later | Only serious UK-accessible broker with API access. |
| Abstraction | Mandatory, dual-target from day one | `BrokerAdapter` = Alpaca + ccxt + IBKR + Simulated, one interface (execution-spec.md). Strategy code must not know which broker it's hitting. |

## State / Persistence

| Component | Choice | Why |
|-----------|--------|-----|
| Open positions / trade log | SQLite (initial) → Postgres (scale) | Crash safety, query flexibility. SQLite gets us to V1. Postgres when concurrent agents need ACID at scale. |
| Config / params | YAML or JSON | Human-editable, git-trackable. |

## Messaging / Alerting

| Component | Choice | Why |
|-----------|--------|-----|
| Dead-man's switch | Telegram bot | Owner's primary messaging channel. Silence itself = alert. |
| Trade notifications | Telegram bot | Same channel, same reason. |

## Logging

| Component | Choice | Why |
|-----------|--------|-----|
| Structured log format | Hand-rolled one-JSON-line-per-entry (`JsonLogger`, `server/apps/orchestrator/logger.ts`) | Every stage already logs through one shared `Logger` interface (`server/shared/types.ts`); the format is six fields. |
| Sinks | stdout + hand-rolled size-rotating file (`server/apps/orchestrator/rotating-file-sink.ts`) | **#325, decided against adding `pino` + `pino-roll`.** ADR-0001's posture is minimal hard dependencies, and the library would not *replace* anything here: the stages log through the shared `Logger` interface, so pino would arrive as a second logging abstraction wrapped by the first. What was actually missing is one `write(line)` byte sink — ~150 lines, synchronous (a line written the instant it is produced survives the crash it describes), degrading to stdout-only on any I/O failure rather than throwing into a tick. |
| Rotation / retention | Size-based, `SAMURAI_LOG_MAX_BYTES` (16 MiB) × `SAMURAI_LOG_MAX_FILES` (10 rotated generations) | Bounded at ~176 MiB, which a 14-day soak (#238) fits inside. Short on purpose: these files are the *diagnostic* record only. The durable trade record — every signal, order and fill, and therefore the UK CGT disposal history CLAUDE.md requires — is SQLite, and nothing in it depends on a rotated log generation surviving. |
| Redaction | Structural walker over `LogEntry.payload` (`server/apps/orchestrator/redact-payload.ts`) | #1035. Applied centrally in `formatLogLine`, not per call site — before this, `sanitizeLogText` was invoked only where a caller remembered to. Deliberately NOT the credential regex over the serialized string: that pattern's value class excludes `"` and `}` but not `{`, so `{"auth":{"scheme":"basic"}}` would redact to unparseable JSON, and an unreadable line is worse than the leak. Guarded so it can never throw — `formatLogLine` is what the both-sinks-dead path builds its last trace from. |
| LLM call capture | `llm_call_log` (migration 0039), gated by `SAMURAI_LLM_CAPTURE` | #1035. `llm_spend` records every fact *about* a call; the prompt and the response text were persisted nowhere, so a soak could report cost and latency but not what was asked or answered. A separate table because `SqliteSpendCap` sums `llm_spend` all-time on the trading path and the dashboard range-scans it — neither reads the text, and multi-KB TEXT columns would balloon that b-tree. Measured ~7 MB per 14-day soak at 64 calls/day. |
| Levels | `debug` / `info` / `warn` / `error`, `SAMURAI_LOG_LEVEL` | #1035. Only `debug` is filterable: `warn`/`error` carry the #714 degradation notices, so a conventional ordered threshold would let an operator configure away the evidence that the logger is failing. |
| Log shipping / aggregation | None | Single-operator, single-host (MacBook). Revisit with the observability-stack open decision below. |

## Testing / Validation

| Tool | Why |
|------|-----|
| pybroker (mined, no hard dependency) | ADR-0001: backtest/eval executor — walkforward-split + eval-metric patterns mined, not depended on. Cannot host live LLM debate (sync per-bar `exec_fn`), so it never runs the live tick loop. |
| Walk-forward analysis | Defends against overfitting |
| Combinatorial Purged Cross-Validation (CPCV) | Distribution of out-of-sample Sharpe |
| Deflated Sharpe Ratio (DSR) | Correct for trial count |
| PBO threshold (0.05) | Kill criterion for suspect strategies |
| MinBTL check | Cap independent trials by data length |
| Custom cost model (ours, not pybroker's) | pybroker's built-in fill model isn't pessimistic enough for the √-law market-impact requirement; injected into pybroker's eval path instead. |

## Dashboard (operator view)

**Supersedes the CLI decision below** — OPEN-GAP-B reversed 2026-07-21; dashboard-spec.md (formerly cli-spec.md) is now canonical.

| Component | Choice | Why |
|-----------|--------|-----|
| Rendering | **Vite + React**, self-hosted alongside the orchestrator | Resolved by [ADR-0010](adr/0010-dashboard-vite-react-rewrite.md) and [`research/40-dashboard-framework-and-hosting.md`](research/40-dashboard-framework-and-hosting.md). The static-page approach broke down on three counts: `server.ts` has no route that can serve a file, the client was composed by `Function.prototype.toString()` over 16 hand-listed functions, and 339 lines of browser JS sat outside tsc and Biome. Vercel is out — read-only FS, archived-when-idle, and a Hobby-tier commercial-use ban. |
| Transport | One `http` server serving the built client plus `GET /api/snapshot` | Still one process and one command at runtime, but ADR-0010 adds a Vite build step ahead of it — the server now needs a route that can serve static assets from `dist/client/`, which the original static-page design lacked. `/api/snapshot` now has **per-request bearer-token auth** whenever `SAMURAI_DASHBOARD_TOKEN` is configured (#1038, `server/apps/service-api/request-auth.ts`); the standing hazard [#887](https://github.com/dd-jp/samurai-trading-system/issues/887) (2026-08-26, [ADR-0019](adr/0019-dashboard-hosting-topology.md)) named is shipped too: `createDashboardServer` (`server/apps/service-api/server.ts`) refuses to start when `host` resolves outside the loopback allowlist (`127.0.0.1`/`::1`) AND the `SAMURAI_DASHBOARD_TOKEN` env var is not configured — matching the repo's existing refuse-by-design posture (`SAMURAI_MODE=live` throws rather than doing something surprising, `paper-profile.ts:2044`). The boot-time guard (`server/apps/service-api/bind-guard.ts`) and the request-time check are two separate reads of the same credential for two separate questions — see that file's `assertBindAllowed` doc comment. The request-time check covers `GET /api/snapshot` only; the static bundle stays unauthenticated by deliberate design (`request-auth.ts`'s header) since the client has no way to attach a header to its own page load. |
| Refresh | Client-side polling | No real-time push needed at single-operator scale; matches the original CLI decision's "a few seconds of staleness is fine" reasoning. |
| Read path | Direct SQLite queries via `QueryStore` | No new message bus; Dashboard is a pure read-only consumer of the shared store (dashboard-spec.md), reusing the CLI's original `QueryStore` port unchanged. |

---

## Resolved (previously "Open Decisions")

- **TypeScript subagent framework: custom, not LangChain.js/LangGraph.** ADR-0001: reuse posture is "mine the Python repos for patterns, no hard dependency" — ruled out a cross-language framework dependency. The adversarial bull/bear/moderator pattern is reimplemented as a TS state machine / lightweight agent-loop.
- **Debate engine protocol: structured JSON rounds.** debate-engine-spec.md — `DebateResult`/`DebateLog` are typed structures (direction, conviction, per-analyst contributions), not free-form LLM output.
- **Feedback loop: bounded parameter/weight adaptation, not model retraining.** feedback-loop-spec.md — daily batch, capped step changes, asymmetric guardrails. No online learning, no retraining.

## Open Decisions (implementation-detail, do not block `/to-tickets`)

- [ ] Analyst persona registry (static config vs dynamic LLM-generated)
- [ ] Monitoring / observability stack beyond structured logs + Telegram (Grafana/Prometheus, or logs+Telegram is sufficient for v1?)
- [ ] Multi-strategy support: shared broker abstraction per-strategy, or unified? (post-MVP question)
- [x] ~~Framework/library, if any, if the dashboard ever grows past one static page~~ — **resolved 2026-08-06: Vite + React, self-hosted** (ADR-0010; see Dashboard row above)
