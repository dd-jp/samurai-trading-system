# Samurai Trading System

Live-money multi-agent trading system covering **crypto and stocks**.

The runtime tick is **six stages** — Analysts → Debate → Trader → Risk → Verdict → Execution — driven by `SequentialTickRunner` (`src/orchestrator/tick-runner.ts`), with a Feedback Loop that adjusts analyst weights and risk thresholds post-trade.

A seventh stage, **Invalidation** (the devil's-advocate critic, between Trader and Risk), is **specced but not built** — see `docs/specs/devils-advocate-spec.md`. The dashboard already renders its column at full width so its rows appear the day it ships (`src/dashboard/pipeline-types.ts`), but nothing writes an `invalidation` row today.

## Architecture

```
Market Data Service ─┐
                     ├─→ Analysts (parallel) → Debate Engine → Trader → [Invalidation*] → Risk Manager → Verdict → Execution → Feedback Loop
Market Intelligence ─┘                                                                                                             │
                                                                                                                                   ↑
                                                                                                                    adjusts weights, thresholds

* specced, not built — the runtime chain goes Trader → Risk today
```

| Stage | Directory | What it does |
|-------|-----------|-------------|
| Market Data Service | `src/market-data-service/` | OHLCV bars + deterministic technical indicators (RSI, ATR, moving averages) with point-in-time discipline. Sources: Alpaca (equities+crypto), ccxt, IBKR, routed by asset class |
| Market Intelligence | `src/market-intelligence/` | Sentiment/news context via the Grok agent over Nous; WorldMonitor CII consumer (adapter parked until `WORLDMONITOR_API_KEY` is set) |
| Analysts | `src/analysts/` | Stateless per-tick agents (technical, fundamental, sentiment). Pure function of data + weight |
| Debate Engine | `src/debate-engine/` | Bull/Bear/Mediator personas, round orchestration, semantic disagreement detection, weighted conviction scoring, LLM rate limiting + spend cap |
| Trader | `src/trader/` | Consolidates debate result into broker-agnostic bracket (OrderIntent). Position-aware branching, setup vectors, cosine precedent lookup |
| Risk Manager | `src/risk-manager/` | Position-size caps, drawdown/volatility circuit breakers, portfolio exposure limits, correlation checks, CII mapping, live-read risk thresholds |
| Verdict | `src/verdict/` | Final go/no-go gate. Idempotency dedup, market-open check, kill-switch re-check, Telegram/Discord notification + approval callbacks |
| Execution | `src/execution/` | Broker abstraction (Alpaca MVP, Simulated for backtest; ccxt/IBKR sources exist, adapters are long-term). Bracket expansion, fill ingestion, reconcile-on-restart, unpriced-fill alerting |
| Feedback Loop | `src/feedback-loop/` | Post-trade attribution, bounded weight adjustment, daily cycle, metrics suite (Sharpe/Sortino/etc.), kill-threshold guardrails |
| Cost Model / Backtest | `src/cost-model-backtest/` | Pessimistic fill simulation, full validation suite (walk-forward, CPCV, PBO, MinBTL, DSR), injected-clock replay, Stage-2 selection + verdict |
| Orchestrator | `src/orchestrator/` | Tick loop scheduler, trace-ID propagation, audit log, dead-man's-switch heartbeat, alert channels, rotating log sink, production composition root (ADR-0004) |
| Dashboard | `src/dashboard/` | Read-only HTTP operator view: pipeline lanes per instrument, positions, verdicts, provider-status tiles |
| Serve | `src/serve/` | Supervises orchestrator + dashboard as one foreground process |
| Scripts | `src/scripts/` | Hand-run Stage-2 tooling: history ingestion, spread calibration, cost decomposition, Stage-2 evaluation |
| Shared | `src/shared/` | Types/ports, clock injection, SQLite store + migrations, HTTP (token-bucket pacing, retry, timeouts), Nous LLM client + pricing |

## Tech Stack

- **Language:** TypeScript (Node 24+ per `engines`; CI pins `.nvmrc` = 24)
- **Package manager:** Yarn 4.18.0 (via Corepack; `packageManager` field). There is no `package-lock.json`
- **Tests:** Vitest
- **Linter/formatter:** Biome
- **State:** SQLite via `better-sqlite3`, one file per environment (`data/samurai-<env>.sqlite`), 20 forward migrations
- **Brokers:** Alpaca (MVP paper), Simulated (backtest); ccxt/IBKR are long-term targets behind the same `BrokerAdapter` interface
- **LLM:** single provider — Nous (ADR-0009), per-role models

## Prerequisites

- Node.js 24
- Corepack enabled (`corepack enable`) — Yarn 4 comes from `packageManager`, no Yarn binary is vendored
- (Optional) Alpaca API key for paper trading
- (Optional) Nous API key for live LLM debate

## Quick Start

```bash
# Install dependencies
yarn install --immutable

# Run tests
yarn test

# Type-check (src + test projects)
yarn typecheck

# Build (emits dist/, copies SQL migrations)
yarn build

# Lint
yarn lint
yarn lint:fix
```

`yarn precommit` runs format → lint:fix → typecheck → test:coverage in one pass.

## Running the System

### Orchestrator (live tick loop)

```bash
yarn orchestrator
```

Runs the full pipeline: market data → analysts → debate → trader → risk → verdict → execution. The scheduler routes crypto (24/7) and stocks (market hours via the trading calendar). Default universe is SPY, QQQ, AAPL, TSLA, BTC-USD, ETH-USD (`DEFAULT_UNIVERSE` in `src/orchestrator/scheduler.ts`).

`yarn orchestrator` builds first, then runs `node --env-file=.env.local dist/orchestrator/index.js`. The built entrypoint does **not** read a `.env` file on its own — pass `--env-file` or export the variables. The tracked `.env` holds empty placeholders and is not a configured environment; real credentials belong in the gitignored `.env.local`. An empty or whitespace-only value counts as **missing**, not as configured.

#### Required environment

The orchestrator refuses to start rather than guess, and names *every* missing variable in one error (`missingCredentialEnvVars`, `src/orchestrator/index.ts`).

| Variable | Values | Purpose |
| --- | --- | --- |
| `SAMURAI_MODE` | `paper` (default) / `backtest` / `live` | Selects the broker environment and HITL posture. Not trimmed on purpose — `live` is reachable only by typing it exactly. The shipped entrypoint refuses `live`; see `src/orchestrator/paper-profile.ts` |
| `SAMURAI_ALERTS` | `telegram` / `log-only` — **required, no default** | Where operator alerts go |
| `ALPACA_API_KEY`, `ALPACA_API_SECRET` | | Broker + market data (one per-account rate budget covers both) |
| `NOUS_BASE_URL` | | LLM endpoint. Unconditional — there is deliberately no default in source |
| `NOUS_API_KEY` | | Shared LLM key. Satisfied instead by a per-role key (`NOUS_DEBATE_API_KEY` or `NOUS_SENTIMENT_API_KEY`) — "a key per model" is a supported setup |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` | | Required only when `SAMURAI_ALERTS=telegram`. `TELEGRAM_CHAT_ID` is the **escalation** chat: orphaned `go` verdicts, stuck unpriced fills, kill-threshold breaches. Keep it unmuted |
| `TELEGRAM_HEARTBEAT_CHAT_ID` | | Required when `SAMURAI_ALERTS=telegram`, and must be a **different** chat from `TELEGRAM_CHAT_ID`. The dead-man's-switch heartbeat posts here and nothing else does, so muting the beat cannot silence an escalation. Startup refuses the two being equal (#342) |

#### Optional — LLM roles and models

Two roles, each with its own default model. Set a `_MODEL` override only if you mean to; a model with no rate in `src/shared/llm/pricing.ts` is **refused at startup**, because an unpriced call records a null cost and the spend cap sums nulls as zero — silently removing ADR-0008's ceiling.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOUS_DEBATE_MODEL` | `anthropic/claude-haiku-4.5` | Debate-engine persona model |
| `NOUS_SENTIMENT_MODEL` | `x-ai/grok-4.5` | Market-intelligence sentiment model. Pinned on purpose (ADR-0009); the floating alias `~x-ai/grok-latest` also works — the leading `~` is required |
| `NOUS_MODEL` | | Shared fallback for any role without its own `_MODEL` |
| `SAMURAI_SENTIMENT` | unset (enabled) | Only the literal `off` disables the market-intelligence agent. With it off, `sentiment` and `fundamental` report NO DATA rather than a fabricated neutral read |

#### Optional — other providers

| Variable | Used by |
| --- | --- |
| `POLYGON_API_KEY` | Stage-2 historical bars (free tier: 5 calls/min, ~2 years of history — a fallback source, not the backfill source) |
| `TIINGO_API_KEY` | `yarn ingest-history` — Stage-2 history ingestion |
| `WORLDMONITOR_API_KEY` | WorldMonitor CII feed (ADR-0002). The adapter stays parked until this is set |
| `PORT`, `HOST` | Dashboard bind address (defaults `8787`, `127.0.0.1`) |

#### Optional — venue pacing

Each broker adapter paces its own outbound calls through a token bucket, so the system stops issuing the request that earns a 429 rather than only retrying after one. The checked-in defaults are in `src/shared/http/venue-pacing.ts`, where every value carries its provenance — whether the figure is the venue's published limit (cited by URL) or a conservative placeholder that could not be verified.

They are overridable because **a rate limit is a property of the account, not of the code**: two operators on different tiers cannot both be right about a compiled-in literal. `<VENUE>` is `ALPACA`, `CCXT` or `IBKR`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAMURAI_PACING_<VENUE>_CAPACITY` | Alpaca `14`, ccxt `1`, IBKR `5` | Burst: how many calls may go out back-to-back from a full bucket. Must be at least `1` — a bucket that can never mint a whole token parks every call forever |
| `SAMURAI_PACING_<VENUE>_REFILL_PER_SEC` | Alpaca `2.5`, ccxt `1`, IBKR `5` | Sustained rate once the burst is spent. Refused if it exceeds the venue's documented ceiling |
| `SAMURAI_PACING_<VENUE>_PRIORITY_RESERVE` | Alpaca `6`, ccxt `0`, IBKR `0` | Tokens the order path keeps for itself, which background market-data calls may not spend (#391). Must leave at least one token for background callers, or they park forever |
| `SAMURAI_PACING_<VENUE>_CEILING_PER_SEC` | Alpaca `3.33` (200/min), IBKR `50`, ccxt none | The ceiling the refill rate is checked against — i.e. what **this account** is documented as entitled to. Set it only when the venue has granted an allowance above its published figure; raising it is a deliberate act, separate from tuning throughput, because pacing above a real limit earns 429s and, sustained, a banned key |

Alpaca's published limit is **200 requests per minute per account**, shared by the broker calls and the market-data calls. Since #391 both consumers sit inside one bucket, so the sustained default is a deliberate 75% of that ceiling (2.5/s = 150/min), leaving margin for retry attempts and any future consumer on the same key.

**Polygon is paced separately** (`SAMURAI_PACING_POLYGON_*`, same variable shapes, ceiling 5/min) and is deliberately **not** a venue key: the live composition root never validates or builds it, so a typo in a Stage-2-only variable cannot kill orchestrator boot mid-soak (#510/#520).

#### Optional — durable log sink

`yarn orchestrator` writes the structured log to stdout **and** to a rotating file, so a run started without a shell redirect still leaves a diagnostic trace behind. All three variables are optional; the defaults are the intended configuration.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAMURAI_LOG_FILE` | `logs/orchestrator.log` | Active log file. Created `0o600` in a `0o700` directory; `logs/` is gitignored |
| `SAMURAI_LOG_MAX_BYTES` | `16777216` (16 MiB) | Rotate when the active file would exceed this |
| `SAMURAI_LOG_MAX_FILES` | `10` | Rotated generations kept (`orchestrator.log.1` … `.10`), excluding the active file. On-disk ceiling is therefore ~176 MiB. `0` means **keep nothing**: rotation discards the full file rather than renaming it, so only the last `SAMURAI_LOG_MAX_BYTES` of history survive. It does not mean "never rotate" |

A malformed value is refused at startup rather than defaulted. An **unwritable** path is not: the sink degrades to stdout-only, logs one `warn` saying file logging is off until restart, and the process keeps running — a logging problem must never end a trading run.

Retention is deliberately short. These files are the *diagnostic* record; the durable trade record (every signal, order and fill, and so the UK CGT disposal history) is SQLite, and nothing in it depends on a log generation surviving.

**Attended vs unattended (`SAMURAI_ALERTS`).** Five operator alerts — the dead-man's-switch heartbeat, an orphaned `go` verdict found at restart, a fill the venue will not price, a kill-threshold breach, and a proposed risk-threshold loosening — are the only warning an operator gets that the system has stopped or is stuck.

- `SAMURAI_ALERTS=telegram` pushes them to Telegram: the escalations to `TELEGRAM_CHAT_ID`, and the heartbeat to `TELEGRAM_HEARTBEAT_CHAT_ID` on its own (#342), so muting the beat cannot mute an escalation. **This is the posture an unattended run requires**, and the only one appropriate for the 14-day soak.
- `SAMURAI_ALERTS=log-only` writes them to stdout instead. Legitimate for an **attended** run — local development, a supervised smoke test, a backtest — where somebody is reading the log stream. It logs a `warn` at startup saying so.

There is deliberately no default. A process that silently fell back to log-only would look healthy right up until the day it stopped and nobody noticed.

### Smoke run (pre-soak gate)

```bash
yarn smoke
```

An **offline** end-to-end run through all six stages with no Alpaca call — it proves the wiring, not the credentials or venue semantics. Universe is BTC-USD only, so a closed US session cannot make an empty tick plan look like a clean run. It does not clear ADR-0004 §5's "wiring validated" bar, which needs one real paper tick.

### Dashboard (operator view)

```bash
yarn dashboard          # http://127.0.0.1:8787
```

Read-only HTTP view over the same SQLite file the orchestrator writes: pipeline lanes per instrument, positions, debates, verdicts, per-analyst performance, LLM spend against the cap, and provider-status tiles. It resolves the store path from `SAMURAI_MODE` exactly as the orchestrator does — `NODE_ENV` stopped selecting the file in #330 — so it cannot show a healthy, empty system from the wrong file. Provider credentials are optional here — a missing key degrades that tile to `not_configured` rather than blocking startup.

#### Running it locally against real orchestrator data

**`SAMURAI_MODE` is mandatory.** `resolveStoreMode()` throws rather than defaulting, and `src/dashboard/index.ts` calls it before anything else, so a dashboard started without it does not come up at all. That refusal is the point: the alternative is a process that guesses a mode, opens the wrong file, and renders a healthy, empty page while the orchestrator is trading in the other one.

| `SAMURAI_MODE` | Store file the dashboard opens |
| --- | --- |
| `paper` | `data/samurai-paper.sqlite` |
| `backtest` | `data/samurai-backtest.sqlite` |
| `live` | `data/samurai-live.sqlite` |

**Two ways to run it.**

```bash
# 1. Built bundle, one process — what an operator runs, and what `yarn dashboard` does.
#    The same node:http server serves the React bundle from dist/dashboard-web/ AND /api/snapshot.
yarn build
SAMURAI_MODE=paper node dist/dashboard/index.js        # http://127.0.0.1:8787

# 2. Vite dev server — hot reload while working on src/dashboard-web/.
#    TWO processes: Vite serves the page, the dashboard server still serves the data.
SAMURAI_MODE=paper PORT=8799 node dist/dashboard/index.js &   # data
PORT=8799 yarn dev:web                                        # page → http://localhost:5173
```

`vite.config.ts` proxies `/api` to `http://127.0.0.1:${PORT ?? 8787}`, so **both processes must agree on `PORT`** — export it for the dev server too, or the page loads and every poll 404s. Production never proxies; there is one process and no dev server. Vite's dev server binds IPv6 first, so reach it as `localhost`, not `127.0.0.1`; the dashboard server itself binds `127.0.0.1`.

Check the data path before trusting the page:

```bash
curl -s http://127.0.0.1:8787/api/snapshot | head -c 400
```

`mode` must be the mode you started with, and the store-backed figures — `debates`, `analysts`, `llm_spend.all_time.cost_usd` — must carry real numbers. Those are the honest check that the page is reading the orchestrator's file.

**`pipeline.lanes` is not that check.** The lane universe is `latest_mark ∪ current_tick`, and `latest_mark` holds one row per instrument the Market Data Service has *priced on demand* — which is neither the tick universe nor a record of what ticked recently. So the hero can show idle chips for instruments that last traded days ago while omitting an instrument that completed a trace a minute ago. See [#619](https://github.com/dd-jp/samurai-trading-system/issues/619).

**An empty-but-healthy page almost always means the wrong working directory.** `sharedStorePath()` returns a **relative** path (`data/samurai-<mode>.sqlite`), which the server resolves against its own cwd, and `openSharedStore()` **creates and migrates** a database that isn't there. Started from a directory with no `data/`, the dashboard therefore opens a brand-new empty store and renders a perfectly healthy screen with nothing in it. Run it from the repo root — the same directory the orchestrator runs from. That relative path is also why a second checkout (a git worktree, say) must **copy** the store rather than point at the running one: opening it read-write would migrate a live database under a running process.

An orchestrator that is up but between ticks legitimately shows idle chips in the Lobby — that is a reading, not a fault. `tick_status: null` with lanes present means no pass is in flight right now.

### Both together

```bash
yarn serve
```

Builds once, then supervises the orchestrator and the dashboard as one foreground process; a single Ctrl-C stops both. Signals are forwarded to the children and the supervisor waits for both to exit rather than exiting first — killing it mid-tick is what creates an orphaned verdict. Either child dying takes the other down with a non-zero exit. `yarn orchestrator` remains the money-path entrypoint for the unattended soak.

### Stage-2 backtest / validation

Hand-run scripts, not part of the tick loop:

```bash
# Tiingo history → SQLite (needs TIINGO_API_KEY)
yarn ingest-history

# The rest run against dist/ after `yarn build`. They read POLYGON_API_KEY /
# TIINGO_API_KEY, so pass the env file the same way `yarn orchestrator` does.
node --env-file=.env.local dist/scripts/run-stage2.js                   # walk-forward / CPCV / PBO / MinBTL / DSR
node --env-file=.env.local dist/scripts/run-spread-calibration.js       # measured spreads for the cost model
node --env-file=.env.local dist/scripts/run-stage2-cost-decomposition.js
```

`SAMURAI_STAGE2_COST_CONFIG=pessimistic` selects the pessimistic cost config for a direct Stage-2 run; anything else uses the calibrated one.

## Testing

```bash
# Full suite
yarn test

# Watch mode
yarn test:watch

# With coverage
yarn test:coverage

# Specific stage
yarn vitest run src/debate-engine/
```

The suite is **2466 tests across 165 files** (2465 passing; one `describe.skipIf` integration test that runs only when live LLM credentials are present).

CI (`.github/workflows/ci.yml`) runs on every PR and has two jobs:

- **checks** — `yarn lint`, `yarn typecheck`, `yarn build`, `yarn test`. Each runs even if an earlier one fails, so a lint break can't hide a test break.
- **review-harness** — `pytest .github/scripts` for the Python AI-review harness, which `yarn test` cannot see.

Both must pass before merge.

## Project Structure

```
samurai-trading-system/
├── src/
│   ├── analysts/          # Stateless per-tick agents
│   ├── cost-model-backtest/  # Fill simulation, validation, replay, Stage-2 selection
│   ├── dashboard/         # Read-only operator HTTP view
│   ├── debate-engine/     # Bull/Bear/Mediator, rounds, conviction, LLM client
│   ├── execution/         # Broker adapters, bracket expansion, fills, reconcile
│   ├── feedback-loop/     # Attribution, weights, metrics, guardrails
│   ├── market-data-service/  # OHLCV + indicators + sources
│   ├── market-intelligence/  # Sentiment (Grok/Nous), WorldMonitor CII
│   ├── orchestrator/      # Tick loop, scheduler, audit, heartbeat, composition root
│   ├── risk-manager/      # Caps, breakers, portfolio view, correlation
│   ├── scripts/           # Hand-run Stage-2 tooling
│   ├── serve/             # Orchestrator + dashboard supervisor
│   ├── shared/            # Types, clock, SQLite store + migrations, HTTP, LLM
│   ├── trader/            # OrderIntent, position-aware branching, setup vectors
│   └── verdict/           # Final gate, notifications, approval callbacks
├── docs/
│   ├── adr/               # Architecture Decision Records (0001–0009)
│   ├── prototypes/        # Throwaway design probes
│   ├── research/          # Strategy evaluation, deployment plan, provider research
│   ├── reviews/           # Audit + readiness reports
│   ├── specs/             # Synthesized PRDs per stage + cross-spec verification
│   ├── wayfinder/         # Historical design maps (new ones are GitHub issues)
│   └── coding-standards.md
├── .github/workflows/     # CI + AI review
├── CLAUDE.md              # Project briefing (read every session)
├── CONTEXT.md             # Domain glossary
├── package.json
├── tsconfig.json          # Solution file — references the two below, for editors
├── tsconfig.build.json    # Build/emit config: src/ only, no tests
└── tsconfig.test.json     # Type-checks the test suite
```

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — Project briefing, standing rules, broker plan, deployment target
- **[CONTEXT.md](CONTEXT.md)** — Domain glossary: terms, relationships, invariants
- **[docs/specs/](docs/specs/)** — Full specs (PRDs) for each pipeline stage, plus cross-spec contracts
- **[docs/adr/](docs/adr/)** — Architecture Decision Records
- **[docs/reviews/](docs/reviews/)** — Code-quality, spec-conformance and readiness audits
- **[docs/research/](docs/research/)** — Strategy evaluation, tech stack research, deployment plan
- **[docs/coding-standards.md](docs/coding-standards.md)** — Repo coding standards
- **[docs/wayfinder/](docs/wayfinder/)** — Historical design maps (current ones live as GitHub issues)

## Key Design Decisions

- **Broker abstraction from day one.** Strategy code never knows which broker it's talking to. Alpaca (MVP) + Simulated today, ccxt + IBKR behind the same interface.
- **One LLM provider.** ADR-0009: everything goes through Nous, one base URL, a model per role. An unpriced model is refused at startup so the spend cap can't be silently voided.
- **Fully automatic execution, capped.** ADR-0007: no human gate in paper or live. ADR-0008: a hard LLM spend ceiling ($50 / 14 days) — an unconfigured budget logs a loud `warn` that spend is uncapped.
- **Analysts are stateless.** Pure function of data + weight. No rolling state. Indicators computed by Market Data Service, not inside analysts.
- **Debate surfaces disagreements.** Bull/Bear/Mediator personas argue before the Trader consolidates. Disagreements are detected and scored, not averaged away.
- **Gates don't act.** A short-circuit at analysts, trader, risk or verdict makes Execution unreachable — the gate-vs-actor separation the tick runner guarantees.
- **Crash-restart safety.** Shared SQLite store, forward-only migrations. Idempotent order IDs. Startup reconcile against the venue. Open positions survive restart.
- **Money graduation:** backtest → paper → tiny live. First live capital is "tuition money."
- **API keys:** trade-only permissions, withdrawals disabled, IP-whitelisted.

## Status

All twelve charted components are implemented and under test; the pipeline runs end-to-end offline (`yarn smoke`). Outstanding:

- **One real Alpaca paper tick** — ADR-0004 §5's "wiring validated" bar. `yarn smoke` is offline and does not clear it.
- **Invalidation stage** — specced (`docs/specs/devils-advocate-spec.md`), not built.
- **14-day unattended soak** (#238) — the "paper trading achieved" bar; not yet run.
- **ccxt / IBKR broker adapters** — data sources exist, order adapters are the long-term path.
- **WorldMonitor CII feed** — consumer seam built, live wiring parked pending `WORLDMONITOR_API_KEY`.
