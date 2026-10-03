# Samurai Trading System

> **Samurai v2 (2026-09-19).** The goal is `CONTEXT.md`'s North Star; the rulings are `docs/research/66-v2-grill-decisions.md`; the plan is `docs/research/67-v2-plan-and-handoff.md`; the one ADR is `docs/adr/0001-samurai-v2.md`. Everything below this banner describes the **v1** runtime that is still in the tree (frozen, to be torn down in doc 67 Step 5); its ADRs and specs were deleted per ruling G8 and are preserved at tag `v1-final`.

Live-money multi-agent trading system for **equities**. Crypto left the system's scope on 2026-08-16 (ADR-0015's amendment) and a future separate system inherits it; the crypto code paths named below (the ccxt data source, the BTC-USD smoke run, the per-asset-class breakers) are still in the tree and still run.

The runtime tick is **six stages** — Analysts → Debate → Trader → Risk → Verdict → Execution — driven by `SequentialTickRunner` (`server/apps/orchestrator/tick-runner.ts`), with a Feedback Loop that adjusts analyst weights and risk thresholds post-trade. <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->

A seventh **Invalidation** stage (the devil's-advocate critic, between Trader and Risk) was proposed in `docs/specs/devils-advocate-spec.md` and **declined as a standalone stage on 2026-09-02** — the pipeline is six stages and stays six. Its typed, falsifiable invalidation-condition mechanism folds into the already-built Risk Critic inside the Risk Manager instead ([#957](https://github.com/dd-jp/samurai-trading-system/issues/957) built, fold tracked as [#994](https://github.com/dd-jp/samurai-trading-system/issues/994)). `PIPELINE_STAGES` in `contracts/pipeline.ts` and the dashboard's v2 rooms grid carried the seventh stage as a live placeholder until [#998](https://github.com/dd-jp/samurai-trading-system/issues/998) retired it — six stages now, no permanently-dark seventh (the dashboard's v3 lane matrix, [ADR-0021](docs/adr/0021-dashboard-v3-rail-layout.md), draws six cells from `PIPELINE_STAGES` directly). Nothing has ever written an `invalidation` row and nothing ever will. <!-- cite-exempt: historical — v1 record; the spec was deleted per ruling G8 and is preserved at tag v1-final -->

## Architecture

```
Market Data Service ─┐
                     ├─→ Analysts (parallel) → Debate Engine → Trader → Risk Manager → Verdict → Execution → Feedback Loop
                                                                                                                   │
                                                                                                                   ↑
                                                                                    adjusts weights, thresholds
```

| Stage | Directory | What it does |
|-------|-----------|-------------|
| Market Data Service | `server/providers/market-data-service/` | OHLCV bars + deterministic technical indicators (RSI, ATR, moving averages) with point-in-time discipline. Sources: Alpaca (equities+crypto), ccxt, IBKR, routed by asset class |
| Market Intelligence | `server/providers/market-intelligence/` | Sentiment/news context via the Grok agent over Nous |
| Analysts | `server/pipeline/analysts/` | Stateless per-tick agents (technical, fundamental, sentiment). Pure function of data + weight | <!-- cite-exempt: historical — deleted in v1 teardown wave 3 (#1748); preserved at tag v1-final -->
| Debate Engine | `server/pipeline/debate-engine/` | Bull/Bear/Mediator personas, round orchestration, semantic disagreement detection, weighted conviction scoring, LLM rate limiting + spend cap |
| Trader | `server/pipeline/trader/` | Consolidates debate result into broker-agnostic bracket (OrderIntent). Position-aware branching, setup vectors, cosine precedent lookup | <!-- cite-exempt: historical — deleted in v1 teardown wave 3 (#1748); preserved at tag v1-final -->
| Risk Manager | `server/pipeline/risk-manager/` | Position-size caps, drawdown/volatility circuit breakers, portfolio exposure limits, correlation checks, CII mapping, live-read risk thresholds, and the Risk Critic (`server/pipeline/risk-manager/critic.ts`) | <!-- cite-exempt: historical — deleted in v1 teardown wave 3 (#1748); preserved at tag v1-final -->
| Verdict | `server/pipeline/verdict/` | Final go/no-go gate. Idempotency dedup, market-open check, kill-switch re-check, Telegram notification + approval callbacks | <!-- cite-exempt: historical — deleted in v1 teardown wave 3 (#1748); preserved at tag v1-final -->
| Execution | `server/pipeline/execution/` | Broker abstraction (Alpaca MVP, Simulated for backtest; ccxt/IBKR sources exist, adapters are long-term). Bracket expansion, fill ingestion, reconcile-on-restart, unpriced-fill alerting | <!-- cite-exempt: historical — deleted in v1 teardown wave 3 (#1748); preserved at tag v1-final -->
| Feedback Loop | `server/pipeline/feedback-loop/` | Post-trade attribution, bounded weight adjustment, daily cycle, metrics suite (Sharpe/Sortino/etc.), kill-threshold guardrails | <!-- cite-exempt: historical — deleted in v1 teardown wave 3 (#1748); preserved at tag v1-final -->
| Cost Model / Backtest | `server/tools/backtest/` | Pessimistic fill simulation, full validation suite (walk-forward, CPCV, PBO, MinBTL, DSR), injected-clock replay, Stage-2 selection + verdict |
| Orchestrator | `server/apps/orchestrator/` | Tick loop scheduler, trace-ID propagation, audit log, dead-man's-switch heartbeat, alert channels, rotating log sink, production composition root (ADR-0004). Opens no socket | <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->
| Service API | `server/apps/service-api/` | Read-only HTTP backend on `:8787`: `GET /api/snapshot` plus the built client bundle. Pipeline lanes per instrument, positions, verdicts, provider-status tiles | <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->
| Supervisor | `server/apps/supervisor/` | Runs the orchestrator and the service API as children of one foreground process | <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->
| Tools | `server/tools/` | Repo gates (citations, live-money gates, CRAP, mutation) and the Saxo token keep-alive |
| Shared | `server/shared/` | Types/ports, clock injection, SQLite store + migrations, HTTP (token-bucket pacing, retry, timeouts), Nous LLM client + pricing |
| Client | `client/` | The Vite + React operator UI (ADR-0010). Built to `dist/client/` — it is not a running process |
| Contracts | `contracts/` | The wire model both runtimes import and neither owns. JSON-serializable shapes only |

## Tech Stack

- **Language:** TypeScript (Node 24+ per `engines`; CI pins `.nvmrc` = 24)
- **Package manager:** npm 11.17.0 (`packageManager` field pins it for Corepack-aware tooling). `package-lock.json` is committed
- **Tests:** Vitest
- **Linter/formatter:** oxlint (`.oxlintrc.json` — barrel/import-boundary enforcement, comment-slop rules) partitioned against Biome (`biome.json` — recommended rules + formatting; `noUnusedVariables` off so oxlint is the sole owner of unused-vars). `npm run lint` runs both in sequence
- **State:** SQLite via `better-sqlite3`, one file per environment (`data/samurai-<env>.sqlite`), 39 forward migrations
- **Brokers:** Alpaca (MVP paper) and Simulated (backtest) are the only order adapters in the tree. The decided live equities venue is **Saxo Capital Markets UK (GIA), over OpenAPI** (ADR-0015's 2026-08-30 amendment) — no adapter is built yet. IBKR was disqualified on cost (#906) and Trading 212 is barred by its own algo-trading terms (#896); ccxt/IBKR survive as data sources
- **LLM:** single provider — Nous (ADR-0009), per-role models

## Prerequisites

- Node.js 24 (ships with npm)
- (Optional) Alpaca API key for paper trading
- (Optional) Nous API key for live LLM debate

## Quick Start

```bash
# Install dependencies
npm ci

# Run tests
npm run test

# Type-check (server, tests, client, e2e — four projects)
npm run typecheck

# Build (emits dist/server + dist/contracts + dist/client, copies SQL migrations)
npm run build

# Lint
npm run lint
npm run lint:fix
```

`npm run precommit` runs lint:fix → typecheck → test:local → fallow:boundaries →
fallow:dead-code → fallow:dupes → fallow:css → fallow:guard (staged files only) in one
pass. There is no separate format step: `biome check` **is** the formatter as well as
one of the two linters, so `npm run lint` already fails on an unformatted file and
`npm run lint:fix` already rewrites it. A check-only `yarn format` used to lead that
chain, which made the gate abort on precisely the fault the next step existed to fix.

## Running the System

### Environment

This reference predates v2. It describes what the v1 orchestrator read; the orchestrator, service API and supervisor were deleted in v1 teardown wave 2 ([#1748](https://github.com/dd-jp/samurai-trading-system/issues/1748)). The tracked `.env` holds empty placeholders; real credentials belong in the gitignored `.env.local`. An empty or whitespace-only value counts as **missing**, not as configured.

#### Required environment

The orchestrator refuses to start rather than guess, and names *every* missing variable in one error (`missingCredentialEnvVars`, `server/apps/orchestrator/index.ts`). <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->

| Variable | Values | Purpose |
| --- | --- | --- |
| `SAMURAI_MODE` | `paper` (default) / `backtest` / `live` | Selects the broker environment and HITL posture. Not trimmed on purpose — `live` is reachable only by typing it exactly. `live` now boots `liveStartingProfile` (`server/apps/orchestrator/live-profile.ts`, #511) rather than being refused: `paperStartingProfile` still refuses it, but the shipped entrypoint routes around it via `startingProfileForMode`. A live run additionally needs `SAMURAI_LIVE_MAX_CAPITAL_USD` below, and still cannot price an LSE book — see [#895](https://github.com/dd-jp/samurai-trading-system/issues/895) | <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->
| `SAMURAI_LIVE_MAX_CAPITAL_USD` | | **Required when `SAMURAI_MODE=live`**, and only then. The capital ceiling every live cap and position size is derived from — a positive number of US dollars, with no default and no fallback. It is a ceiling, not a funding: sizing takes `min(ceiling, account equity)`. A value below the floor is refused rather than clamped. It is USD-denominated against a GBP book and nothing converts — see [#949](https://github.com/dd-jp/samurai-trading-system/issues/949) |
| `SAMURAI_ALERTS` | `telegram` / `log-only` — **required, no default** | Where operator alerts go |
| `ALPACA_API_KEY`, `ALPACA_API_SECRET` | | Broker + market data (one per-account rate budget covers both) |
| `NOUS_BASE_URL` | | LLM endpoint. Unconditional — there is deliberately no default in source |
| `NOUS_API_KEY` | | Shared LLM key. Satisfied instead by a per-role key (`NOUS_DEBATE_API_KEY` or `NOUS_SENTIMENT_API_KEY`) — "a key per model" is a supported setup |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | | Required only when `SAMURAI_ALERTS=telegram`. `TELEGRAM_CHAT_ID` is the **escalation** chat: orphaned `go` verdicts, stuck unpriced fills, kill-threshold breaches. Keep it unmuted |
| `TELEGRAM_HEARTBEAT_CHAT_ID` | | Required when `SAMURAI_ALERTS=telegram`, and must be a **different** chat from `TELEGRAM_CHAT_ID`. The dead-man's-switch heartbeat posts here and nothing else does, so muting the beat cannot silence an escalation. Startup refuses the two being equal (#342) |
| `TELEGRAM_ALLOWED_USER_IDS` | | Required by the v2 command poller (`npm run v2:telegram`, #1852), which refuses to start without it. Exactly one positive Telegram user id: the owner, who alone may command the system. Commands are answered in the owner's private chat, whose id equals the user id. Alerts still go to `TELEGRAM_CHAT_ID`, which may be a group |

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
| `SAXO_SIM_ACCOUNT_KEY`, `SAXO_LIVE_ACCOUNT_KEY` | v2 Saxo client (`server/apps/v2/execution/saxo/saxo-http-client.ts`, #1868): the `AccountKey` to trade when the token sees more than one account (GIA + CFD); with two or more and none set, the client refuses. Each environment reads only its own variable, an explicit `accountKey` option wins, and a blank value counts as unset. Treated as a secret by the LLM request guard (#1881). Real keys go in `.env.local` only |
| `PORT`, `HOST` | Dashboard bind address (defaults `8787`, `127.0.0.1`). Binding `HOST` to anything other than `127.0.0.1`/`::1` refuses to start unless `SAMURAI_DASHBOARD_TOKEN` (below) is also set — see #887/ADR-0019 |
| `SAMURAI_DASHBOARD_TOKEN` | Required to bind the dashboard's `HOST` off loopback (#887/ADR-0019). Also verified per request against `GET /api/snapshot` whenever configured, host-independent (#1038) — see `server/apps/service-api/bind-guard.ts` and `request-auth.ts` | <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->

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

**Polygon is paced separately** (`SAMURAI_PACING_POLYGON_*`, same variable shapes; ceiling is 5/min) and is deliberately **not** a venue key — `VENUE_KEYS` is `alpaca`/`ccxt`/`ibkr` only. The live composition root never validates or builds it, so a typo in this Stage-2-only variable cannot kill orchestrator boot mid-soak (#510/#520).

#### Optional — durable log sink

`npm run orchestrator` writes the structured log to stdout **and** to a rotating file, so a run started without a shell redirect still leaves a diagnostic trace behind. All three variables are optional; the defaults are the intended configuration.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAMURAI_LOG_FILE` | `logs/orchestrator.log` | Active log file. Created `0o600` in a `0o700` directory; `logs/` is gitignored |
| `SAMURAI_LOG_MAX_BYTES` | `16777216` (16 MiB) | Rotate when the active file would exceed this |
| `SAMURAI_LOG_MAX_FILES` | `10` | Rotated generations kept (`orchestrator.log.1` … `.10`), excluding the active file. On-disk ceiling is therefore ~176 MiB. `0` means **keep nothing**: rotation discards the full file rather than renaming it, so only the last `SAMURAI_LOG_MAX_BYTES` of history survive. It does not mean "never rotate" |
| `SAMURAI_LOG_RETENTION_DAYS` | `30` | How many days a **finished** log artefact in `logs/` may go unmodified before the boot-time sweep (#1116) removes it. `RotatingFileSink` above bounds only its own configured file; everything else a run leaves in `logs/` — a supervisor's own redirected stdout, a hand-run `> logs/orchestrator-DATE.log` — is unbounded without this. Two name shapes are eligible for this age-based path: a rotation generation (`orchestrator.log.1`) and a datestamped artefact, which since #1206 includes a bare date with no time component (`supervisor-20260904-1020-v3.log`, `soak-boot-20260903-1007.out`, `soak-20260825.log`). An undated bare name (`orchestrator.log`, `service-api.log`, `soak-boot.out`) is the shape a live writer holds open, and is never deleted on age at any window — unlinking a file a process still has open reclaims no space and loses the content — nor is any non-log file ever eligible here. The active sink file and its `.1`…`.N` rotation set are excluded outright as well. The sweep also refuses a directory that is the process's own working directory, warning instead of sweeping, so a `SAMURAI_LOG_FILE` with no directory component never aims it at the repo root. 30 days rather than 14 (the soak's own length, #238) so a completed soak's opening days are still on disk when anyone goes looking afterwards. Refused at startup if malformed or `0`, same reasoning as `SAMURAI_MI_ARCHIVE_RETENTION_DAYS` below (`server/apps/orchestrator/log-retention.ts`) | <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->
| `SAMURAI_LOG_RETENTION_KEEP` | _(none)_ | Comma-separated **basenames** in `logs/` the sweep above must never delete or truncate, whatever their age or size — evidence being kept deliberately, or a datestamped file some long-running writer still holds open. Basenames only: the sweep never leaves the directory it sweeps, so a value containing `/` is refused, as is a stray comma (an entry silently dropped is the one failure this variable exists to prevent) |
| `SAMURAI_LOG_BARE_TRUNCATE_BYTES` | `16777216` (16 MiB) | The age-based sweep above never removes an undated bare name (`soak-boot.out`) — unlinking a file a live writer still holds open would make its growth invisible rather than bounded, and it has no age or descriptor gate of its own (evidence-loss is possible; use `SAMURAI_LOG_RETENTION_KEEP` to exempt a file). This variable gives that same shape a disk-allocation-based path instead (#1206): once an ALLOWLISTED bare `.log`/`.out` file's **allocated disk usage** (`stat.blocks`, not its apparent length) exceeds this many bytes, the sweep `truncate`s it to empty rather than unlinking it. Defaults on like every other setting on this page — safe to default because `SAMURAI_LOG_BARE_TRUNCATE_NAMES` below, not this threshold, is what scopes which files it can ever reach; an earlier revision of this fix made the threshold itself opt-in instead, which left `soak-boot.out` exactly as unbounded as before #1206 in a deployment that never set it (every deployment, in this repo — none of these seven variables are set in any deployment or launch configuration in it: no `.env.example`, launch script, or `plist` sets one, they all just have code-level defaults for an operator who configures nothing; a handful of test files DO assign one directly onto `process.env` to exercise its parser, e.g. `logger.test.ts:499` and `rotating-file-sink.test.ts:359-361`, which is not the same claim). Eligibility and disk freed are measured in allocated blocks rather than apparent size specifically so a live, non-append writer's next write (which lands at its old, pre-truncation offset and leaves a sparse hole, ballooning `stat.size` back up) does not fool a later boot into truncating again and destroying whatever it had appended since — gating on size would do exactly that. The active sink file and its rotation set (`protectedPaths`) and `SAMURAI_LOG_RETENTION_KEEP` both still exclude a name from it, same as the age-based sweep. Refused at startup if malformed or `0` (`server/apps/orchestrator/log-retention.ts`). A truncated-then-appended file reads back with a NUL-filled hole in front of the new content, so a plain `grep` on it reports "binary file matches" instead of printing lines — use `grep -a`. (The non-append-writer premise itself is an assumption inferred from the ticket that named this gap, since no code in this repo has ever written `soak-boot.out`; under `>>` instead of `>`, none of the hole behaviour applies.) | <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->
| `SAMURAI_LOG_BARE_TRUNCATE_NAMES` | `soak-boot.out` | The truncate path's own blast-radius narrowing, ADDITIVE to the built-in default above: a bare `.log`/`.out` file is only ever a truncation candidate if its basename is in this set, whatever its size. `isBareLogName`'s shape check alone matches any undated `.log`/`.out` file — real macOS system logs (`install.log`, `wifi.log`, `system.log`) included — so this is what keeps `SAMURAI_LOG_BARE_TRUNCATE_BYTES` safe to default on rather than requiring opt-in. Comma-separated **basenames** ADDED to `soak-boot.out`, never replacing it — there is no way to shrink this list via this variable; `SAMURAI_LOG_RETENTION_KEEP` already exempts any specific file, truncation included, if an operator needs `soak-boot.out` itself left alone. Same validation as `SAMURAI_LOG_RETENTION_KEEP`: basenames only, a stray comma refused rather than silently dropped (`server/apps/orchestrator/log-retention.ts`) | <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->

A malformed value in these seven variables is refused at startup rather than defaulted. An **unwritable** path is not: the sink degrades to stdout-only, logs one `warn` saying file logging is off until restart, and the process keeps running — a logging problem must never end a trading run.

Retention is deliberately short. These files are the *diagnostic* record; the durable trade record (every signal, order and fill, and so the UK CGT disposal history) is SQLite, and nothing in it depends on a log generation, or a whole file in `logs/`, surviving.

#### Optional — verbosity and LLM call capture

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAMURAI_LOG_LEVEL` | `info` | `debug` also writes `debug`-level lines. It is the **only** filterable level: `warn` and `error` always write, because they carry the sink-degradation notices a run's last trace depends on, and a verbosity setting must not be able to configure the process into silence |
| `SAMURAI_LLM_CAPTURE` | on (unset) | The prompt sent and the text returned for every metered LLM call, persisted to `llm_call_log` and written on one `llm call:` log line alongside model, both token counts, `cost_usd` and latency. `off` disables. Both variables parse leniently — only the literal `debug` / `off` (case-insensitive, trimmed) does anything, so a typo silently resolves to the default rather than being refused (`server/apps/orchestrator/logger.ts`, `server/apps/orchestrator/production.ts`). Measured cost of leaving it on: ~7 MB per 14-day soak | <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->
| `SAMURAI_LLM_CALL_LOG_MAX_ROWS` | `5000` | Rows of `llm_call_log` kept. The newest survive; the rest are deleted at boot and again on the daily feedback timer. ~78 days and ~39 MB at the measured capture rate, ~100 MB if every row hit both caps. Unlike the two above, a malformed value is **refused at startup** rather than defaulted — it is retention policy, and a window nobody chose is worse than a refusal. `0` is rejected too: to keep nothing, set `SAMURAI_LLM_CAPTURE=off` (`server/shared/store/prune-llm-call-log.ts`) | <!-- cite-exempt: historical — deleted in v1 teardown wave 5 (#1748); preserved at tag v1-final -->
| `SAMURAI_MI_ARCHIVE_RETENTION_DAYS` | `90` | How many days of `mi_archive_raw`/`mi_items` history the MI archive (`data/samurai-mi-{mode}.sqlite`) keeps. Rows older than the window are deleted at boot and again on the daily feedback timer — the specced 90-day auto-purge (`docs/specs/market-intelligence-spec.md`), unimplemented until #1060. A DAY window here, not a row ceiling like the setting above: archive value is genuinely time-bound (a 90-day-old news item is not useful to a backtest replay of last week), unlike LLM capture volume, which is cadence-bound. Refused at startup if malformed or `0`, same reasoning as `SAMURAI_LLM_CALL_LOG_MAX_ROWS` (`server/providers/market-intelligence/archive/mi-archive-store.ts`) | <!-- cite-exempt: historical — v1 record; the spec was deleted per ruling G8 and is preserved at tag v1-final -->
| `SAMURAI_ALERT_DELIVERY_FAILURE_RETENTION_DAYS` | `30` | How many days of `alert_delivery_failures` rows the orchestrator keeps ([#1131](https://github.com/dd-jp/samurai-trading-system/issues/1131)), deleted at boot and again on the daily feedback timer like the two rows above. A DAY window rather than a row ceiling for the MI archive's reason: this table's growth tracks outage and event frequency, not a tick cadence. **Refused at startup below `2`, not merely at `0`** — the message is `must be an integer >= 2`, so an operator who guesses `1` gets a boot refusal rather than a silent default, and the floor is worth explaining. `1` day is exactly the trailing window the Rail's alert-channel tile counts this table over (`ALERT_DELIVERY_FAILURE_WINDOW_MS`, 24h), and at that equality the table stops outliving the tile: `contracts/snapshot.ts` drops the tile's former lifetime total and leaves the same question answerable over the retention window by reading `alert_delivery_failures` directly — bounded by that retention, never a lifetime — which at `retention == window` answers nothing the tile does not already show. That the table outlives the window is the whole reason for the floor. The intuitive one survives only in a form far too narrow to size a day-granularity floor against: at `retention == window` the delete and count predicates overlap only for a prune that commits after a live request's `asOf`, which the sub-second sample-then-read gap inside one snapshot build allows and nothing else does. `server/apps/orchestrator/production.ts` carries both halves of the argument | <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->

Capture answers "what was this call actually asked, and what did it say" — `llm_spend` already records everything *about* a call, and `audit_log` holds digests from which no value can be reconstructed. Text is masked for known credential syntaxes and capped (16 KB prompt, 4 KB response) on the way in. Treat it as a capture, not a scrub: the masker is deliberately narrow, and prompts embed news bodies and analyst free text.

`llm_call_log` is pruned by row count, and only because it is the *diagnostic* record rather than the trade record — the same line the rotating file sink draws for the logs it rotates away. `llm_spend` is never pruned with it: `SqliteSpendCap` sums that table all-time before every debate, so dropping rows there would understate spend against ADR-0008's cap rather than merely losing diagnostics. The MI archive is pruned separately, by age, in its own database file (see the row above), and `alert_delivery_failures` by age as well (#1131) — that one in `config.db`, alongside `llm_call_log`, not a file of its own. Three purges over three distinct tables, six call sites — each purge runs once at boot and again on the daily feedback timer: none of them touches another's rows. Note that `DELETE` does not shrink the SQLite file — freed pages are reused, so the file plateaus rather than falls, and no `VACUUM` ships (it would take an exclusive lock on a live trading process).

**Attended vs unattended (`SAMURAI_ALERTS`).** Five operator alerts — the dead-man's-switch heartbeat, an orphaned `go` verdict found at restart, a fill the venue will not price, a kill-threshold breach, and a proposed risk-threshold loosening — are the only warning an operator gets that the system has stopped or is stuck.

- `SAMURAI_ALERTS=telegram` pushes them to Telegram: the escalations to `TELEGRAM_CHAT_ID`, and the heartbeat to `TELEGRAM_HEARTBEAT_CHAT_ID` on its own (#342), so muting the beat cannot mute an escalation. **This is the posture an unattended run requires**, and the only one appropriate for the 14-day soak.
- `SAMURAI_ALERTS=log-only` writes them to stdout instead. Legitimate for an **attended** run — local development, a supervised smoke test, a backtest — where somebody is reading the log stream. It logs a `warn` at startup saying so.

There is deliberately no default. A process that silently fell back to log-only would look healthy right up until the day it stopped and nobody noticed.

### Smoke run

```bash
npm run smoke
```

Builds, then runs `node dist/server/apps/v2/smoke.js`: an **offline** dry run of the v2 composition root against a seeded store with scripted LLM transports. It proves the wiring, not the credentials or venue semantics.

## Testing

```bash
# Full suite
npm run test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage

# Only what your branch touched — vitest --changed against origin/main.
# A fast inner-loop check, NOT a substitute for the full run: it needs an
# up-to-date origin/main, and it cannot see a break in a file you did not edit.
npm run test:local

# Specific stage
npx vitest run server/pipeline/debate-engine/
```

The suite is **7197 tests across 350 files** (7196 passing; one `describe.skipIf` integration test — `server/pipeline/debate-engine/disagreement-detector.integration.test.ts` — that runs only when live LLM credentials are present). Measured 2026-09-17 on `npm run test`. <!-- cite-exempt: historical — deleted in v1 teardown wave 3 (#1748); preserved at tag v1-final -->

`vitest.config.ts` also writes a durable, machine-readable per-test record to
`.vitest-reports/junit.xml` (gitignored) on every run, alongside the normal
console output. If a gate run fails and the terminal scrollback that showed
the failing test's name is gone, read that file instead of re-running —
it survives after the process exits ([#809](https://github.com/dd-jp/samurai-trading-system/issues/809)).

CI (`.github/workflows/ci.yml`) runs on every PR and has two jobs:

- **checks** — `npm run lint:oxlint`, `npm run lint:biome`, Fallow architecture boundaries, `npm run fallow:dead-code`, Fallow duplication (advisory), Fallow design-system drift (advisory), `npm run typecheck`, `npm run build`, `npm run build:web`, `npm run test`, `npm run check:citations`, and a guard that the indicator golden fixture was generated rather than hand-edited. Each runs even if an earlier one fails, so a lint break can't hide a test break.
- **e2e** — the Playwright suite against the built bundle, on its own runner with Chromium installed; failures upload traces.

Mutation testing runs on CI as `mutation-shard` (four runners) and `mutation` (the merged 80% score) when a PR changes a risk, sizing or loss-budget line.

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
│   ├── apps/
│   │   └── v2/            # v2 composition root, sleeves, risk, execution, dashboard API
│   ├── pipeline/          # the six stages + feedback loop
│   │   ├── analysts/      # Stateless per-tick agents
│   │   ├── debate-engine/ # Bull/Bear/Mediator, rounds, conviction, LLM client
│   │   ├── trader/        # OrderIntent, position-aware branching, setup vectors
│   │   ├── risk-manager/  # Caps, breakers, portfolio view, correlation
│   │   ├── verdict/       # Final gate, notifications, approval callbacks
│   │   ├── execution/     # Broker adapters, bracket expansion, fills, reconcile
│   │   └── feedback-loop/ # Attribution, weights, metrics, guardrails
│   ├── providers/         # external data
│   │   ├── market-data-service/   # OHLCV + indicators + sources (incl. the free stack)
│   │   └── market-intelligence/   # Sentiment (Grok/Nous)
│   ├── shared/            # Types, clock, SQLite store + migrations, HTTP, LLM
│   └── tools/             # offline only, never on the money path
│       ├── backtest/      # Fill simulation, validation, replay, Stage-2 selection
│       ├── check-path-citations.ts    # `npm run check:citations` — CI gate over the docs
│       └── check-live-money-gates.ts  # `npm run check:live-gates` — the cited gates are still open
│
├── contracts/             # THE WIRE BOUNDARY — imported by both, importing neither
│                          # JSON-serializable shapes only; boundary.test.ts enforces it
├── e2e/                   # Playwright suite
├── docs/
│   ├── adr/               # One ADR: 0001-samurai-v2.md (v1's 21 ADRs live at tag v1-final)
│   ├── prototypes/        # Throwaway design probes
│   ├── research/          # Strategy evaluation, deployment plan, provider research
│   ├── reviews/           # Audit + readiness reports
│   ├── specs/             # Empty until the v2 sleeve and loss-budget specs are written (v1's 20 specs at tag v1-final)
│   ├── dashboard-v2/      # Dashboard v2 design material
│   ├── wayfinder/         # Historical design maps (new ones are GitHub issues)
│   ├── coding-standards.md
│   └── cgt-disposal-matching.md  # #1518 — live Saxo GIA CGT disposal matching, NOT tax advice
├── .github/workflows/     # CI + AI review
├── CLAUDE.md              # Project briefing (read every session)
├── CONTEXT.md             # Domain glossary
├── package.json
├── tsconfig.json          # Solution file — references the two below, for editors
├── tsconfig.build.json    # Build/emit: server/ + contracts/, no tests
└── tsconfig.test.json     # Type-checks the test suite
```

`dist/` mirrors the source:

```
dist/client/                              # vite outDir — the bundle
dist/server/apps/v2/index.js              # v2 composition root
dist/server/apps/v2/smoke.js              # npm run smoke
```

## Scripts

`package.json` has 46 scripts. This table predates v2: it does not list the `v2:*` scripts, `bars:snapshot`, `crap`, `crap:report` or `saxo:keepalive`.

| Tier | Script | What it does |
| --- | --- | --- |
| dev | `npm run dev:web` | Vite dev server for `client/` → `localhost:5173`. Proxies `/api` to `127.0.0.1:${V2_DASHBOARD_PORT ?? 8788}` |
| build | `npm run build` | `tsc` + `build:migrations` + `build:web`. Emits `dist/` |
| build | `npm run build:migrations` | Copies `server/shared/store/migrations/*.sql` and `server/providers/market-intelligence/archive/migrations/*.sql` into `dist/`. `tsc` emits no `.sql`, so without it the built runtime finds no migrations to apply. Sub-step of `build` |
| build | `npm run build:web` | Client `tsc` + `vite build`. Sub-step of `build`, and **also its own CI step** (`ci.yml`) so a frontend-toolchain failure is named as one instead of surfacing as "build failed" |
| run | `npm run smoke` | Offline end-to-end gate |
| quality | `npm run typecheck` | Four projects: server, tests, client tests, e2e |
| quality | `npm run test` | Full vitest suite |
| quality | `npm run test:coverage` | Same suite under v8 coverage |
| quality | `npm run test:local` | `vitest --changed origin/main` — only what the branch touched. Inner loop, not a gate. What `precommit` runs |
| quality | `npm run test:watch` | Vitest in watch mode |
| quality | `npm run e2e` | Playwright suite against the built bundle, on a port picked fresh per run (#1298) so two checkouts can run it at once. CI job of its own |
| quality | `npm run mutation:local` | `tsx server/tools/mutation-local.ts` — Stryker Mutator on the lines of trading-path files (`pipeline/trader`, `risk-manager`, `verdict`, `execution`, v2 `risk`, v2 `cycle`, `split`, `reconcile` and `reconcile-compare`, momentum `loss-budget` and `sizing`) changed vs a base ref, incremental, 80% score bar on those lines (#1634; doc 66, 2026-10-01). Runs on CI in four shards |
| quality | `npm run lint:oxlint` | `oxlint` — barrel/import-boundary enforcement (`.oxlintrc.json`), comment-slop rules, unused-vars (sole owner — Biome's `noUnusedVariables` is off) |
| quality | `npm run lint:oxlint:fix` | `oxlint --fix` |
| quality | `npm run lint:biome` | `biome check .` — Biome's recommended rules + formatting |
| quality | `npm run lint:biome:fix` | `biome check --write .` |
| quality | `npm run lint` | `lint:oxlint` → `lint:biome`, both gated in CI as separate steps |
| quality | `npm run lint:fix` | `lint:oxlint:fix` → `lint:biome:fix` |
| quality | `npm run fallow:boundaries` | `fallow dead-code --boundary-violations --fail-on-issues` — architecture boundary check. CI step of its own |
| quality | `npm run fallow:dead-code` | `fallow dead-code` — CI step, annotated |
| quality | `npm run fallow:dupes` | `fallow dupes` — duplication, advisory CI step |
| quality | `npm run fallow:css` | `fallow health --css` — design-system drift, advisory CI step |
| quality | `npm run fallow:guard` | `fallow guard` — run in `precommit` only, against the staged file list |
| quality | `npm run precommit` | `lint:fix` → `typecheck` → `test:local` → `fallow:boundaries` → `fallow:dead-code` → `fallow:dupes` → `fallow:css` → `fallow:guard` (staged files only) |
| quality | `npm run check:citations` | `tsx server/tools/check-path-citations.ts` — every backticked path in the tracked docs resolves. **A CI step**, and it reads this file too |
| ops | `npm run check:live-gates` | `tsx server/tools/check-live-money-gates.ts` — re-verifies that the issues the live-money gate list cites are still open, so a closed issue cannot silently falsify the gate |
| ops | `npm run saxo:login` | `tsx --env-file=.env.local server/apps/v2/execution/saxo/saxo-login.ts` — Authorization Code Grant login for Saxo SIM/live, refs #1522 |

**`smoke` builds first**, deliberately. A stale `dist/` fails *silently*: the
process boots and runs the previous build. A redundant `tsc` invocation is the
cheaper side of that trade. The `dev:*` and `tsx`-run scripts are the
exception: they run from source, which is the whole point of them.

**There is no `format` script.** `biome check` formats as well as lints, so
`npm run lint` already fails on an unformatted file and `npm run lint:fix` already
rewrites it — a check-only `format` was a strict subset of `lint` that could
only ever duplicate its verdict.

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — Project briefing, standing rules, broker plan, deployment target
- **[CONTEXT.md](CONTEXT.md)** — Domain glossary: terms, relationships, invariants
- **[docs/adr/0001-samurai-v2.md](docs/adr/0001-samurai-v2.md)** — The one v2 ADR; v1's ADRs and specs are preserved at tag `v1-final`
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

All twelve charted components are implemented and under test; the pipeline runs end-to-end offline (`npm run smoke`). Outstanding:

- **One real Alpaca paper tick** — ADR-0004 §5's "wiring validated" bar. `npm run smoke` is offline and does not clear it.
- **14-day unattended soak** (#238) — the "paper trading achieved" bar. Shorter soaks have run, and a hand-placed lifecycle probe on 2026-08-26 took one position entry → bracket → flat-by-close → venue fill → store close against live paper Alpaca (surfacing and fixing #921/#922). The qualifying 14-day unattended window has not.
- **A Saxo order adapter** — Saxo Capital Markets UK (GIA) over OpenAPI is the decided live venue (ADR-0015, 2026-08-30) and no adapter exists. ccxt and IBKR remain data sources only; IBKR was disqualified as a venue on cost (#906).
