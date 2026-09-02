# Samurai Trading System

Live-money multi-agent trading system covering **crypto and stocks**.

The runtime tick is **six stages** — Analysts → Debate → Trader → Risk → Verdict → Execution — driven by `SequentialTickRunner` (`server/apps/orchestrator/tick-runner.ts`), with a Feedback Loop that adjusts analyst weights and risk thresholds post-trade.

A seventh stage, **Invalidation** (the devil's-advocate critic, between Trader and Risk), is **specced but not built** — see `docs/specs/devils-advocate-spec.md`. The dashboard already reserves its room in the pipeline layout so its rows appear the day it ships (`client/src/lib/room-layout.ts`, whose `STAGE_ORDER` includes `invalidation`), but nothing writes an `invalidation` row today.

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
| Market Data Service | `server/providers/market-data-service/` | OHLCV bars + deterministic technical indicators (RSI, ATR, moving averages) with point-in-time discipline. Sources: Alpaca (equities+crypto), ccxt, IBKR, routed by asset class |
| Market Intelligence | `server/providers/market-intelligence/` | Sentiment/news context via the Grok agent over Nous; WorldMonitor CII consumer (adapter parked until `WORLDMONITOR_API_KEY` is set) |
| Analysts | `server/pipeline/analysts/` | Stateless per-tick agents (technical, fundamental, sentiment). Pure function of data + weight |
| Debate Engine | `server/pipeline/debate-engine/` | Bull/Bear/Mediator personas, round orchestration, semantic disagreement detection, weighted conviction scoring, LLM rate limiting + spend cap |
| Trader | `server/pipeline/trader/` | Consolidates debate result into broker-agnostic bracket (OrderIntent). Position-aware branching, setup vectors, cosine precedent lookup |
| Risk Manager | `server/pipeline/risk-manager/` | Position-size caps, drawdown/volatility circuit breakers, portfolio exposure limits, correlation checks, CII mapping, live-read risk thresholds |
| Verdict | `server/pipeline/verdict/` | Final go/no-go gate. Idempotency dedup, market-open check, kill-switch re-check, Telegram/Discord notification + approval callbacks |
| Execution | `server/pipeline/execution/` | Broker abstraction (Alpaca MVP, Simulated for backtest; ccxt/IBKR sources exist, adapters are long-term). Bracket expansion, fill ingestion, reconcile-on-restart, unpriced-fill alerting |
| Feedback Loop | `server/pipeline/feedback-loop/` | Post-trade attribution, bounded weight adjustment, daily cycle, metrics suite (Sharpe/Sortino/etc.), kill-threshold guardrails |
| Cost Model / Backtest | `server/tools/backtest/` | Pessimistic fill simulation, full validation suite (walk-forward, CPCV, PBO, MinBTL, DSR), injected-clock replay, Stage-2 selection + verdict |
| Orchestrator | `server/apps/orchestrator/` | Tick loop scheduler, trace-ID propagation, audit log, dead-man's-switch heartbeat, alert channels, rotating log sink, production composition root (ADR-0004). Opens no socket |
| Service API | `server/apps/service-api/` | Read-only HTTP backend on `:8787`: `GET /api/snapshot` plus the built client bundle. Pipeline lanes per instrument, positions, verdicts, provider-status tiles |
| Supervisor | `server/apps/supervisor/` | Runs the orchestrator and the service API as children of one foreground process |
| Tools | `server/tools/` | Hand-run Stage-2 tooling: history ingestion, spread calibration, cost decomposition, Stage-2 evaluation |
| Shared | `server/shared/` | Types/ports, clock injection, SQLite store + migrations, HTTP (token-bucket pacing, retry, timeouts), Nous LLM client + pricing |
| Client | `client/` | The Vite + React operator UI (ADR-0010). Built to `dist/client/` and served by the service API — it is not a running process |
| Contracts | `contracts/` | The wire model both runtimes import and neither owns. JSON-serializable shapes only |

## Tech Stack

- **Language:** TypeScript (Node 24+ per `engines`; CI pins `.nvmrc` = 24)
- **Package manager:** Yarn 4.18.0 (via Corepack; `packageManager` field). There is no `package-lock.json`
- **Tests:** Vitest
- **Linter/formatter:** Biome
- **State:** SQLite via `better-sqlite3`, one file per environment (`data/samurai-<env>.sqlite`), 25 forward migrations
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

# Type-check (server, tests, client, e2e — four projects)
yarn typecheck

# Build (emits dist/server + dist/contracts + dist/client, copies SQL migrations)
yarn build

# Lint
yarn lint
yarn lint:fix
```

`yarn precommit` runs lint:fix → typecheck → test:coverage in one pass. There is
no separate format step: `biome check` **is** the formatter as well as the
linter, so `yarn lint` already fails on an unformatted file and `yarn lint:fix`
already rewrites it. A check-only `yarn format` used to lead that chain, which
made the gate abort on precisely the fault the next step existed to fix.

## Running the System

### Orchestrator (live tick loop)

```bash
yarn orchestrator
```

Runs the full pipeline: market data → analysts → debate → trader → risk → verdict → execution. The scheduler routes crypto (24/7) and stocks (market hours via the trading calendar). Default universe is SPY, QQQ, AAPL, TSLA, BTC-USD, ETH-USD (`DEFAULT_UNIVERSE` in `server/apps/orchestrator/scheduler.ts`).

`yarn orchestrator` builds first, then runs `node --env-file=.env.local dist/server/apps/orchestrator/index.js`. The built entrypoint does **not** read a `.env` file on its own — pass `--env-file` or export the variables. The tracked `.env` holds empty placeholders and is not a configured environment; real credentials belong in the gitignored `.env.local`. An empty or whitespace-only value counts as **missing**, not as configured.

#### Required environment

The orchestrator refuses to start rather than guess, and names *every* missing variable in one error (`missingCredentialEnvVars`, `server/apps/orchestrator/index.ts`).

| Variable | Values | Purpose |
| --- | --- | --- |
| `SAMURAI_MODE` | `paper` (default) / `backtest` / `live` | Selects the broker environment and HITL posture. Not trimmed on purpose — `live` is reachable only by typing it exactly. The shipped entrypoint refuses `live`; see `server/apps/orchestrator/paper-profile.ts` |
| `SAMURAI_ALERTS` | `telegram` / `log-only` — **required, no default** | Where operator alerts go |
| `ALPACA_API_KEY`, `ALPACA_API_SECRET` | | Broker + market data (one per-account rate budget covers both) |
| `NOUS_BASE_URL` | | LLM endpoint. Unconditional — there is deliberately no default in source |
| `NOUS_API_KEY` | | Shared LLM key. Satisfied instead by a per-role key (`NOUS_DEBATE_API_KEY` or `NOUS_SENTIMENT_API_KEY`) — "a key per model" is a supported setup |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` | | Required only when `SAMURAI_ALERTS=telegram`. `TELEGRAM_CHAT_ID` is the **escalation** chat: orphaned `go` verdicts, stuck unpriced fills, kill-threshold breaches. Keep it unmuted |
| `TELEGRAM_HEARTBEAT_CHAT_ID` | | Required when `SAMURAI_ALERTS=telegram`, and must be a **different** chat from `TELEGRAM_CHAT_ID`. The dead-man's-switch heartbeat posts here and nothing else does, so muting the beat cannot silence an escalation. Startup refuses the two being equal (#342) |

#### Optional — LLM roles and models

Two roles, each with its own default model. Set a `_MODEL` override only if you mean to; a model with no rate in `server/shared/llm/pricing.ts` is **refused at startup**, because an unpriced call records a null cost and the spend cap sums nulls as zero — silently removing ADR-0008's ceiling.

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
| `PORT`, `HOST` | Dashboard bind address (defaults `8787`, `127.0.0.1`). Binding `HOST` to anything other than `127.0.0.1`/`::1` refuses to start unless `SAMURAI_DASHBOARD_TOKEN` (below) is also set — see #887/ADR-0019 |
| `SAMURAI_DASHBOARD_TOKEN` | Required to bind the dashboard's `HOST` off loopback (#887/ADR-0019). Checked only at boot, not per request — see `server/apps/service-api/bind-guard.ts` |

#### Optional — venue pacing

Each broker adapter paces its own outbound calls through a token bucket, so the system stops issuing the request that earns a 429 rather than only retrying after one. The checked-in defaults are in `server/shared/http/venue-pacing.ts`, where every value carries its provenance — whether the figure is the venue's published limit (cited by URL) or a conservative placeholder that could not be verified.

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

#### Optional — verbosity and LLM call capture

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAMURAI_LOG_LEVEL` | `info` | `debug` also writes `debug`-level lines. It is the **only** filterable level: `warn` and `error` always write, because they carry the sink-degradation notices a run's last trace depends on, and a verbosity setting must not be able to configure the process into silence |
| `SAMURAI_LLM_CAPTURE` | on | The prompt sent and the text returned for every metered LLM call, persisted to `llm_call_log` and written on one `llm call:` log line alongside model, both token counts, `cost_usd` and latency. `off` disables. Measured cost of leaving it on: ~7 MB per 14-day soak |

Capture answers "what was this call actually asked, and what did it say" — `llm_spend` already records everything *about* a call, and `audit_log` holds digests from which no value can be reconstructed. Text is masked for known credential syntaxes and capped (16 KB prompt, 4 KB response) on the way in. Treat it as a capture, not a scrub: the masker is deliberately narrow, and prompts embed news bodies and analyst free text.

**Attended vs unattended (`SAMURAI_ALERTS`).** Five operator alerts — the dead-man's-switch heartbeat, an orphaned `go` verdict found at restart, a fill the venue will not price, a kill-threshold breach, and a proposed risk-threshold loosening — are the only warning an operator gets that the system has stopped or is stuck.

- `SAMURAI_ALERTS=telegram` pushes them to Telegram: the escalations to `TELEGRAM_CHAT_ID`, and the heartbeat to `TELEGRAM_HEARTBEAT_CHAT_ID` on its own (#342), so muting the beat cannot mute an escalation. **This is the posture an unattended run requires**, and the only one appropriate for the 14-day soak.
- `SAMURAI_ALERTS=log-only` writes them to stdout instead. Legitimate for an **attended** run — local development, a supervised smoke test, a backtest — where somebody is reading the log stream. It logs a `warn` at startup saying so.

There is deliberately no default. A process that silently fell back to log-only would look healthy right up until the day it stopped and nobody noticed.

### Smoke run (pre-soak gate)

```bash
yarn smoke
```

An **offline** end-to-end run through all six stages with no Alpaca call — it proves the wiring, not the credentials or venue semantics. Universe is BTC-USD only, so a closed US session cannot make an empty tick plan look like a clean run. It does not clear ADR-0004 §5's "wiring validated" bar, which needs one real paper tick.

### Service API + client (operator view)

```bash
yarn api                # http://127.0.0.1:8787   (alias: yarn dashboard)
```

Read-only HTTP view over the same SQLite file the orchestrator writes: pipeline lanes per instrument, positions, debates, verdicts, per-analyst performance, LLM spend against the cap, and provider-status tiles. It resolves the store path from `SAMURAI_MODE` exactly as the orchestrator does — `NODE_ENV` stopped selecting the file in #330 — so it cannot show a healthy, empty system from the wrong file. Provider credentials are optional here — a missing key degrades that tile to `not_configured` rather than blocking startup.

#### Running it locally against real orchestrator data

**`SAMURAI_MODE` is mandatory.** `resolveStoreMode()` throws rather than defaulting, and `server/apps/service-api/index.ts` calls it before anything else, so a dashboard started without it does not come up at all. That refusal is the point: the alternative is a process that guesses a mode, opens the wrong file, and renders a healthy, empty page while the orchestrator is trading in the other one.

| `SAMURAI_MODE` | Store file the dashboard opens |
| --- | --- |
| `paper` | `data/samurai-paper.sqlite` <!-- cite-exempt: untracked — a runtime store file, created on first run and gitignored by design; which of the three exists on any given machine depends only on which modes have been run there --> |
| `backtest` | `data/samurai-backtest.sqlite` <!-- cite-exempt: untracked — a runtime store file, created on first run and gitignored by design; which of the three exists on any given machine depends only on which modes have been run there --> |
| `live` | `data/samurai-live.sqlite` <!-- cite-exempt: untracked — a runtime store file, created on first run and gitignored by design; which of the three exists on any given machine depends only on which modes have been run there --> |

**Two ways to run it.**

```bash
# 1. Built bundle, one process — what an operator runs, and what `yarn api` does.
#    The same node:http server serves the React bundle from dist/client/ AND /api/snapshot.
yarn build
SAMURAI_MODE=paper node dist/server/apps/service-api/index.js        # http://127.0.0.1:8787

# 2. Vite dev server — hot reload while working on client/.
#    TWO terminals: Vite serves the page, the service API still serves the data.
SAMURAI_MODE=paper PORT=8799 yarn dev:api                     # data  (tsx watch, no build)
PORT=8799 yarn dev:web                                        # page → http://localhost:5173
```

`yarn dev:api` runs the service API from source under `tsx`, so it restarts on
edit and needs no `yarn build`. It always prints the
`*** DASHBOARD UI NOT SERVABLE ***` banner, and in dev that is expected noise
rather than a fault: from source `bundleRoot` resolves to `client/`, the Vite
*source* template, because in this mode the page is Vite's job on `:5173` and
the API's job is only `/api/snapshot`.

`vite.config.ts` proxies `/api` to `http://127.0.0.1:${PORT ?? 8787}`, so **both processes must agree on `PORT`** — export it for the dev server too, or the page loads and every poll 404s. Production never proxies; there is one process and no dev server. Vite's dev server binds IPv6 first, so reach it as `localhost`, not `127.0.0.1`; the dashboard server itself binds `127.0.0.1`.

Check the data path before trusting the page:

```bash
curl -s http://127.0.0.1:8787/api/snapshot | head -c 400
```

`mode` must be the mode you started with, and the store-backed figures — `debates`, `analysts`, `llm_spend.all_time.cost_usd` — must carry real numbers. Those are the honest check that the page is reading the orchestrator's file.

**`pipeline.lanes` is not that check.** The lane universe is `latest_mark ∪ current_tick`, and `latest_mark` holds one row per instrument the Market Data Service has *priced on demand* — which is neither the tick universe nor a record of what ticked recently. So the hero can show idle chips for instruments that last traded days ago while omitting an instrument that completed a trace a minute ago. See [#619](https://github.com/dd-jp/samurai-trading-system/issues/619).

**An empty-but-healthy page almost always means the wrong working directory.** `sharedStorePath()` returns a **relative** path (`data/samurai-<mode>.sqlite`), which the server resolves against its own cwd, and `openSharedStore()` **creates and migrates** a database that isn't there. Started from a directory with no `data/`, the dashboard therefore opens a brand-new empty store and renders a perfectly healthy screen with nothing in it. Run it from the repo root — the same directory the orchestrator runs from. That relative path is also why a second checkout (a git worktree, say) must **copy** the store rather than point at the running one: opening it read-write would migrate a live database under a running process.

An orchestrator that is up but between ticks legitimately shows idle chips in the Lobby — that is a reading, not a fault. `tick_status: null` with lanes present means no pass is in flight right now.

### Both together — the one command an operator runs

```bash
yarn start              # alias: yarn serve
```

Builds once, then supervises the orchestrator and the service API as one foreground process; a single Ctrl-C stops both. There is no third process for the UI: the client is a static bundle that the service API serves. Signals are forwarded to the children and the supervisor waits for both to exit rather than exiting first — killing it mid-tick is what creates an orphaned verdict. Either child dying takes the other down with a non-zero exit. `yarn orchestrator` remains the money-path entrypoint for the unattended soak.

### Stage-2 backtest / validation

Hand-run scripts, not part of the tick loop:

```bash
# Tiingo history → SQLite (needs TIINGO_API_KEY)
yarn data ingest-history        # alias: yarn ingest-history

# Warm-start OHLCV bars for the live universe, from the free stack
yarn data backfill-market-data  # alias: yarn backfill-market-data

# The rest run against dist/ after `yarn build`. They read POLYGON_API_KEY /
# TIINGO_API_KEY, so pass the env file the same way `yarn orchestrator` does.
node --env-file=.env.local dist/server/tools/run-stage2.js                   # walk-forward / CPCV / PBO / MinBTL / DSR
node --env-file=.env.local dist/server/tools/run-spread-calibration.js       # measured spreads for the cost model
node --env-file=.env.local dist/server/tools/run-stage2-cost-decomposition.js
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

# Only what your branch touched — vitest --changed against origin/main.
# A fast inner-loop check, NOT a substitute for the full run: it needs an
# up-to-date origin/main, and it cannot see a break in a file you did not edit.
yarn test:local

# Specific stage
yarn vitest run server/pipeline/debate-engine/
```

The suite is **2920 tests across 188 files** (2919 passing; one `describe.skipIf` integration test that runs only when live LLM credentials are present). Measured 2026-08-09 on `yarn test`.

`vitest.config.ts` also writes a durable, machine-readable per-test record to
`.vitest-reports/junit.xml` (gitignored) on every run, alongside the normal
console output. If a gate run fails and the terminal scrollback that showed
the failing test's name is gone, read that file instead of re-running —
it survives after the process exits ([#809](https://github.com/dd-jp/samurai-trading-system/issues/809)).

CI (`.github/workflows/ci.yml`) runs on every PR and has two jobs:

- **checks** — `yarn lint`, `yarn typecheck`, `yarn build`, `yarn test`. Each runs even if an earlier one fails, so a lint break can't hide a test break.
- **review-harness** — `pytest .github/scripts` for the Python AI-review harness, which `yarn test` cannot see.

Both must pass before merge.

## Project Structure

Two runtimes with two toolchains, and one contract between them. **`client/` and
`server/` never import each other; both import `contracts/`.** That single rule
is what the layout encodes — it replaced a browser app nested five levels inside
the backend's compilation unit, and the pair of `exclude` entries that
arrangement needed in both root tsconfigs.

```
samurai-trading-system/
├── client/                # BROWSER — Vite owns this folder end to end
│   ├── index.html
│   ├── vite.config.ts     # its own app root, not a stray config in the backend tree
│   ├── tsconfig.json      # DOM + JSX; never sees server source
│   └── src/               # main.tsx, components/, hooks/, lib/
│
├── server/                # NODE — tsc owns this folder end to end
│   ├── apps/              # the three runnable programs
│   │   ├── orchestrator/  # Tick loop, scheduler, audit, heartbeat, composition root
│   │   ├── service-api/   # Read-only HTTP :8787; serves /api/snapshot + the bundle
│   │   └── supervisor/    # Runs orchestrator + service-api as one foreground process
│   ├── pipeline/          # the seven stages
│   │   ├── analysts/      # Stateless per-tick agents
│   │   ├── debate-engine/ # Bull/Bear/Mediator, rounds, conviction, LLM client
│   │   ├── trader/        # OrderIntent, position-aware branching, setup vectors
│   │   ├── risk-manager/  # Caps, breakers, portfolio view, correlation
│   │   ├── verdict/       # Final gate, notifications, approval callbacks
│   │   ├── execution/     # Broker adapters, bracket expansion, fills, reconcile
│   │   └── feedback-loop/ # Attribution, weights, metrics, guardrails
│   ├── providers/         # external data
│   │   ├── market-data-service/   # OHLCV + indicators + sources (incl. the free stack)
│   │   └── market-intelligence/   # Sentiment (Grok/Nous), WorldMonitor CII
│   ├── shared/            # Types, clock, SQLite store + migrations, HTTP, LLM
│   └── tools/             # offline only, never on the money path
│       ├── backtest/      # Fill simulation, validation, replay, Stage-2 selection
│       └── data-cli.ts    # `yarn data` — history ingestion, market-data backfill
│
├── contracts/             # THE WIRE BOUNDARY — imported by both, importing neither
│                          # JSON-serializable shapes only; boundary.test.ts enforces it
├── e2e/                   # Playwright suite
├── docs/
│   ├── adr/               # Architecture Decision Records
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
├── tsconfig.build.json    # Build/emit: server/ + contracts/, no tests
└── tsconfig.test.json     # Type-checks the test suite
```

`dist/` mirrors the source, which is why the entry points can find each other
without knowing the working directory:

```
dist/client/                              # vite outDir — the bundle
dist/server/apps/service-api/index.js     # resolves the bundle as ../../../client/
dist/server/apps/orchestrator/index.js    # spawned by the supervisor
dist/server/apps/supervisor/index.js      # yarn start
```

## Scripts

Every script in `package.json`, all 23 of them. There are no others.

| Tier | Script | What it does |
| --- | --- | --- |
| dev | `yarn dev:web` | Vite dev server for `client/` → `localhost:5173`. Proxies `/api` to the service API |
| dev | `yarn dev:api` | Service API from source under `tsx`, restarts on edit. Run alongside `dev:web` |
| build | `yarn build` | `tsc` + `build:migrations` + `build:web`. Emits `dist/` |
| build | `yarn build:migrations` | Copies `server/shared/store/migrations/*.sql` into `dist/`. `tsc` emits no `.sql`, so without it the built orchestrator finds no migrations to apply. Sub-step of `build` |
| build | `yarn build:web` | Client `tsc` + `vite build`. Sub-step of `build`, and **also its own CI step** (`ci.yml`) so a frontend-toolchain failure is named as one instead of surfacing as "build failed" |
| run | **`yarn start`** | **The one full-system command.** Builds, then supervises orchestrator + service API |
| run | `yarn serve` | Alias for `yarn start` |
| run | `yarn orchestrator` | Money path alone — the unattended-soak entrypoint |
| run | `yarn api` | Operator view alone |
| run | `yarn dashboard` | Alias for `yarn api` |
| run | `yarn smoke` | Offline end-to-end gate |
| data | `yarn data <cmd>` | Dispatcher: `ingest-history` / `backfill-market-data`. Bare `yarn data` prints usage and exits 1 |
| data | `yarn ingest-history` | Alias for `yarn data ingest-history` |
| data | `yarn backfill-market-data` | Alias for `yarn data backfill-market-data` |
| quality | `yarn typecheck` | Four projects: server, tests, client tests, e2e |
| quality | `yarn test` | Full vitest suite |
| quality | `yarn test:coverage` | Same suite under v8 coverage. What `precommit` runs |
| quality | `yarn test:local` | `vitest --changed origin/main` — only what the branch touched. Inner loop, not a gate |
| quality | `yarn test:watch` | Vitest in watch mode |
| quality | `yarn e2e` | Playwright suite against the built bundle on `:8788`. CI job of its own |
| quality | `yarn lint` | `biome check .` — lint **and** formatting, both gated in CI |
| quality | `yarn lint:fix` | `biome check --write .` — fixes both |
| quality | `yarn precommit` | `lint:fix` → `typecheck` → `test:coverage` |

**Five run scripts build first** (`start`, `orchestrator`, `api`, `smoke`,
`data`), deliberately. A stale `dist/` fails *silently* — the process boots and
serves the previous build — and `sharedStorePath()` resolving against the
working directory means the wrong cwd yields a fresh empty database and a
healthy-looking blank page. Redundant `tsc` invocations are the cheaper side of
that trade. The two `dev:*` scripts are the exception: they run from source
(Vite, `tsx`), which is the whole point of them.

**The four aliases are kept on purpose**, not left over. `serve`/`dashboard`
are the names an operator's muscle memory and several source comments still
use (`server/apps/supervisor/supervisor.ts`, `e2e/playwright.config.ts`);
`ingest-history`/`backfill-market-data` predate the `yarn data` dispatcher and
survive because a runbook or cron entry may name either (see the header of
`server/tools/data-cli.ts`). Renaming a script an unattended job invokes fails
silently outside the checkout, where nothing here can see it.

**There is no `format` script.** `biome check` formats as well as lints, so
`yarn lint` already fails on an unformatted file and `yarn lint:fix` already
rewrites it — a check-only `format` was a strict subset of `lint` that could
only ever duplicate its verdict.

The Stage-2 tools (`run-stage2`, `run-spread-calibration`,
`run-stage2-cost-decomposition`) have **no** script and are not missing one.
They are hand-run research jobs, invoked as `node --env-file=.env.local
dist/server/tools/<name>.js` after a build — see
[Stage-2 backtest / validation](#stage-2-backtest--validation).

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — Project briefing, standing rules, broker plan, deployment target
- **[CONTEXT.md](CONTEXT.md)** — Domain glossary: terms, relationships, invariants
- **[docs/specs/](docs/specs/)** — Full specs (PRDs) for each pipeline stage, plus cross-spec contracts
- **[docs/adr/](docs/adr/)** — Architecture Decision Records
- **[docs/reviews/](docs/reviews/)** — Code-quality, spec-conformance and readiness audits. Start at [docs/reviews/README.md](docs/reviews/README.md); closed/superseded reports live in [docs/reviews/archive/](docs/reviews/archive/)
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
