# Samurai Trading System

Live-money multi-agent trading system covering **crypto and stocks**. Six-stage pipeline: Analysts → Debate → Trader → Risk → Verdict → Execution, with a Feedback Loop that adjusts analyst weights and risk thresholds post-trade.

## Architecture

```
Market Data Service ─┐
                     ├─→ Analysts (parallel) → Debate Engine → Trader → Risk Manager → Verdict → Execution → Feedback Loop
Market Intelligence ─┘                                                                                          │
                                                                                                                ↑
                                                                                                          adjusts weights, thresholds
```

| Stage | Directory | What it does |
|-------|-----------|-------------|
| Market Data Service | `src/market-data-service/` | OHLCV bars + deterministic technical indicators (RSI, ATR, moving averages) with point-in-time discipline |
| Market Intelligence | `src/market-intelligence/` | News + sentiment context serving, cross-source conflict resolution |
| Analysts | `src/analysts/` | Stateless per-tick agents (technical, fundamental, sentiment). Pure function of data + weight |
| Debate Engine | `src/debate-engine/` | Bull/Bear/Mediator personas, round orchestration, semantic disagreement detection, conviction scoring |
| Trader | `src/trader/` | Consolidates debate result into broker-agnostic bracket (OrderIntent). Position-aware branching |
| Risk Manager | `src/risk-manager/` | Position-size caps, drawdown circuit breakers, portfolio exposure limits, correlation checks |
| Verdict | `src/verdict/` | Final go/no-go gate. Idempotency dedup, market-open check, kill-switch re-check, HITL approval |
| Execution | `src/execution/` | Broker abstraction (Alpaca MVP, ccxt/Kraken, IBKR, Simulated). Bracket expansion, partial-fill handling, crash-restart WAL |
| Feedback Loop | `src/feedback-loop/` | Post-trade attribution, bounded weight adjustment, metrics suite (Sharpe/Sortino/etc.), kill-threshold alerting |
| Cost Model / Backtest | `src/cost-model-backtest/` | Pessimistic fill simulation, full validation suite (walk-forward, CPCV, PBO, MinBTL), injected-clock replay |
| Orchestrator | `src/orchestrator/` | Tick loop scheduler, trace-ID propagation, audit log, dead-man's-switch heartbeat |
| CLI | `src/cli/` | Operator dashboard: positions, verdicts, debates, performance. Watch mode + one-shot |
| Shared | `src/shared/` | Types, clock injection, shared state store interface |

## Tech Stack

- **Language:** TypeScript (Node 22+, `--experimental-strip-types`)
- **Tests:** Vitest
- **Linter:** Biome
- **State:** SQLite (shared state store)
- **Brokers:** Alpaca (MVP paper), ccxt (Kraken/Coinbase), IBKR (long-term stocks), Simulated (backtest)
- **LLM:** Anthropic Claude (via debate engine LLM client abstraction)

## Prerequisites

- Node.js 22+
- npm 10+
- (Optional) Alpaca API key for paper trading
- (Optional) Anthropic API key for live LLM debate

## Quick Start

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type-check
npm run build

# Lint
npm run lint
npm run lint:fix
```

## Running the System

### Orchestrator (live tick loop)

```bash
yarn orchestrator
```

Runs the full pipeline: market data → analysts → debate → trader → risk → verdict → execution. Scheduler handles crypto (24/7 WebSocket) and stock market hours.

#### Required environment

The orchestrator refuses to start rather than guess at any of these. It names every missing variable at startup.

| Variable | Values | Purpose |
| --- | --- | --- |
| `SAMURAI_MODE` | `paper` (default) / `backtest` / `live` | Selects the broker environment and the HITL posture. The shipped entrypoint refuses `live` — see `src/orchestrator/paper-profile.ts`. |
| `SAMURAI_ALERTS` | `telegram` / `log-only` — **required, no default** | Where operator alerts go. |
| `ALPACA_API_KEY`, `ALPACA_API_SECRET` | | Broker + market data. |
| `ANTHROPIC_API_KEY` | | LLM debate. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` | | Required only when `SAMURAI_ALERTS=telegram`. `TELEGRAM_CHAT_ID` is the **escalation** chat: orphaned `go` verdicts, stuck unpriced fills, kill-threshold breaches. Keep it unmuted. |
| `TELEGRAM_HEARTBEAT_CHAT_ID` | | Required when `SAMURAI_ALERTS=telegram`, and must be a **different** chat from `TELEGRAM_CHAT_ID`. The dead-man's-switch heartbeat posts here every 15 minutes and nothing else does, so muting it cannot silence an escalation. Startup refuses the two being equal. |

#### Optional — durable log sink

`yarn orchestrator` writes the structured log to stdout **and** to a rotating file, so a run started without a shell redirect still leaves a diagnostic trace behind. All three variables are optional; the defaults are the intended configuration.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAMURAI_LOG_FILE` | `logs/orchestrator.log` | Active log file. Created `0o600` in a `0o700` directory; `logs/` is gitignored. |
| `SAMURAI_LOG_MAX_BYTES` | `16777216` (16 MiB) | Rotate when the active file would exceed this. |
| `SAMURAI_LOG_MAX_FILES` | `10` | Rotated generations kept (`orchestrator.log.1` … `.10`), excluding the active file. On-disk ceiling is therefore ~176 MiB. `0` means **keep nothing**: rotation discards the full file rather than renaming it, so only the last `SAMURAI_LOG_MAX_BYTES` of history survive. It does not mean "never rotate". |

A malformed value is refused at startup rather than defaulted. An **unwritable** path is not: the sink degrades to stdout-only, logs one `warn` saying file logging is off until restart, and the process keeps running — a logging problem must never end a trading run.

Retention is deliberately short. These files are the *diagnostic* record; the durable trade record (every signal, order and fill, and so the UK CGT disposal history) is SQLite, and nothing in it depends on a log generation surviving.


**Attended vs unattended (`SAMURAI_ALERTS`).** Three escalations — the dead-man's-switch heartbeat, an orphaned `go` verdict found at restart, and a fill the venue will not price — are the only warning an operator gets that the system has stopped or is stuck.

- `SAMURAI_ALERTS=telegram` pushes all three to the trade channel. **This is the posture an unattended run requires**, and the only one appropriate for the 14-day soak.
- `SAMURAI_ALERTS=log-only` writes them to stdout instead. Legitimate for an **attended** run — local development, a supervised smoke test, a backtest — where somebody is reading the log stream. It logs a `warn` at startup saying so.

There is deliberately no default. A process that silently fell back to log-only would look healthy right up until the day it stopped and nobody noticed.

`node dist/orchestrator/index.js` does not read a `.env` file on its own — use `node --env-file=.env.local dist/orchestrator/index.js`, or export the variables. The tracked `.env` holds empty placeholders and is not a configured environment; real credentials belong in the gitignored `.env.local`.

### CLI (operator dashboard)

```bash
# One-shot snapshot
npm run cli -- status

# Watch mode (periodic refresh)
npm run cli -- watch
```

### Backtest

The backtest harness replays historical data through the same pipeline with an injected clock:

```bash
# Via the cost-model-backtest module (see src/cost-model-backtest/backtest.ts)
```

## Testing

```bash
# Full suite
npm test

# Watch mode
npm run test:watch

# Specific stage
npx vitest run src/debate-engine/
```

All 700+ tests must pass before merge. Type-check (`tsc --noEmit`) is enforced on every PR.

## Project Structure

```
samurai-trading-system/
├── src/
│   ├── analysts/          # Stateless per-tick agents
│   ├── cli/               # Operator dashboard
│   ├── cost-model-backtest/  # Fill simulation, validation, replay
│   ├── debate-engine/     # Bull/Bear/Mediator, rounds, conviction
│   ├── execution/         # Broker adapters, bracket expansion, fills
│   ├── feedback-loop/     # Attribution, weights, metrics, guardrails
│   ├── market-data-service/  # OHLCV + indicators
│   ├── market-intelligence/  # News + sentiment
│   ├── orchestrator/      # Tick loop, scheduler, audit, heartbeat
│   ├── risk-manager/      # Caps, breakers, portfolio view
│   ├── shared/            # Types, clock, state store interface
│   ├── trader/            # OrderIntent, position-aware branching
│   └── verdict/           # Final gate, HITL, notifications
├── docs/
│   ├── adr/               # Architecture Decision Records
│   ├── research/          # Strategy evaluation, deployment plan
│   ├── specs/             # Synthesized PRDs per stage
│   └── wayfinder/         # Design maps + grilling decisions
├── CLAUDE.md              # Project briefing (read every session)
├── CONTEXT.md             # Domain glossary
├── package.json
└── tsconfig.json
```

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — Project briefing, standing rules, broker plan, deployment target
- **[CONTEXT.md](CONTEXT.md)** — Domain glossary: terms, relationships, invariants
- **[docs/specs/](docs/specs/)** — Full specs (PRDs) for each pipeline stage
- **[docs/wayfinder/](docs/wayfinder/)** — Design maps with resolved decisions
- **[docs/adr/](docs/adr/)** — Architecture Decision Records
- **[docs/research/](docs/research/)** — Strategy evaluation, tech stack research, deployment plan

## Key Design Decisions

- **Broker abstraction from day one.** Strategy code never knows which broker it's talking to. Alpaca (MVP) + ccxt + IBKR + Simulated behind one interface.
- **Analysts are stateless.** Pure function of data + weight. No rolling state. Indicators computed by Market Data Service, not inside analysts.
- **Debate surfaces disagreements.** Bull/Bear/Mediator personas argue before the Trader consolidates. Disagreements are detected and scored, not averaged away.
- **Crash-restart safety.** Shared SQLite store. Idempotent order IDs. Write-ahead logging in Execution. Open positions survive restart.
- **Money graduation:** backtest → paper → tiny live. First live capital is "tuition money."
- **API keys:** trade-only permissions, withdrawals disabled, IP-whitelisted.

## Status

All 12 stages implemented. ~700 tests passing. Ready for paper trading integration.
