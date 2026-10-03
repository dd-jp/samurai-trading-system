# Samurai Trading System

Samurai is an autonomous, self-improving trading system. Its goal is the North Star in [CONTEXT.md](CONTEXT.md): a steady net profit over each year, and never more than £1,500 of net trading loss in a calendar year. This README describes the v2 system as it stands on `main`. It is a summary; the rulings live in the doc chain below and win wherever the two differ.

**Status:** paper only. The first real paper cycle ran on 2026-09-30 and the paper soak is under way (doc 67 Step 6), with the Step 4b assurance checklist continuing alongside it. Nothing has passed the go-live gate, and the composition root refuses `SAMURAI_MODE=live`. The v1 runtime is deleted (doc 67 Step 5, teardown waves 1–5; closing summary in `docs/research/77-v1-teardown-reachability.md`) and preserved at tag `v1-final`.

## Read first

| Document | What it holds |
|---|---|
| [CONTEXT.md](CONTEXT.md) | North Star, then the v2 glossary: terms, relationships, invariants |
| [CLAUDE.md](CLAUDE.md) | Project briefing and standing rules |
| [docs/research/66-v2-grill-decisions.md](docs/research/66-v2-grill-decisions.md) | David's rulings; wins over everything else |
| [docs/adr/0001-samurai-v2.md](docs/adr/0001-samurai-v2.md) | The one ADR, with every open item listed |
| [docs/research/67-v2-plan-and-handoff.md](docs/research/67-v2-plan-and-handoff.md) | Ordered work (Steps 0–6), definition of done, loose-ends register |
| [docs/research/68-fable-handoff.md](docs/research/68-fable-handoff.md) | Session prompts and the session eval |
| [docs/v1-postmortem.md](docs/v1-postmortem.md) | The six v1 pitfalls that bind v2 |
| [docs/specs/](docs/specs/) | The debate sleeve, signals sleeve and dashboard specs |
| [docs/research/README.md](docs/research/README.md), [docs/reviews/README.md](docs/reviews/README.md) | Research and audit indexes |

The map issue is [#1706](https://github.com/dd-jp/samurai-trading-system/issues/1706).

## The system

**Sleeves.** Each sleeve has its own capital share, universe, entry rule, benchmark, paper book and go-live rule, and gets its share of the start capital, the loss cap and the daily cap.

- **Debate (30%).** A daily swing sleeve. Before the open, three debaters (Sonnet 5, DeepSeek, GPT) argue each screened name and a judge (Opus 5.5) settles it, on daily bars, candle features and news. Positions hold for days to weeks and exit by a broker-resting stop or a time stop; bounded shorts are allowed. Its benchmark is **arm 2**: the same names, stops and exits, with an indicator-only entry and no LLM. The sleeve cannot be backtested honestly, so its proof is forward paper: at least 100 closed trades and a one-sided 95% test against arm 2. Spec: `docs/specs/debate-sleeve-spec.md`.
- **Signals (the 70% paper share, £7,000).** Since 2026-09-30, external US-long signals arrive on a loopback-only HTTP endpoint. Each entry passes the risk gate and an LLM entry veto, judged against a no-veto shadow book. Spec: `docs/specs/signals-sleeve-spec.md`.
- **Rules-based candidates (no paper cash while signals holds the 70%).** Momentum was dropped on 2026-09-25 (doc 70). Five candidates are backtested in turn, up to 8 counted trials each: cross-asset trend, mean reversion, vol-targeted index hold, post-earnings drift, then the v3 evidence run's fallback entry rule (#1861). A passer carries an LLM entry veto judged against a no-veto shadow. The rulings and each run's result are in doc 66 (S1–S7 and the candidate sections).

**Venues.** Alpaca for US large caps; the debate and signals primary books place real Alpaca paper brackets. Saxo Capital Markets UK GIA over OpenAPI for LSE 1× ETFs/ETCs, plus CFDs on UK and US stocks, indices and ETFs for the debate sleeve and arm 2 only (shorts, and UK single-stock longs). No CFD order is placed, simulated included, until a Saxo resting stop on a CFD is verified (#1916). Arm 2, the shadow books and the LSE leg are simulated on paper. No 3× ETPs, no UK single stocks except through CFDs, no crypto, no intraday sleeve.

**Loss budget.** £1,500 net trading loss per calendar year from start capital, both venues, GBP, marked to market, FX excluded. Size halves at −£500, quarters at −£1,000, and trading halts for the year at −£1,500. A daily loss of 1.0% of start capital blocks new entries; exits still run. The cap is a yearly config David sets (`npm run v2:capital`), never loosened mid-year, and no capital figure is a literal in code.

**Gate and autonomy.** A rules-based sleeve reaches live only after DSR ≥ 0.95, PBO ≤ 0.10, a 40% Sharpe haircut, 8–12 weeks of paper inside the backtest's 90% band with costs within ±25%, and 4 fault-free weeks. Capital is at most £1,500 / (backtest max DD × 1.5); demotion follows 4 weeks outside the 95% band or drawdown above 1.5× the backtest max. Any sleeve that passes its gate (the debate sleeve's is above) then sends a Telegram approval request to David: "no" blocks it, no reply in 24 hours approves it, and the exchange is recorded to a GitHub issue.

**Protection.** Every position carries a broker-resting stop. Each cycle reconciles the store against the broker before any entry. Every decision, fill and LLM call is journalled, and any past day replays to the same decisions. LLM spend is capped at about $30 a month; a breach stops LLM calls, never exits. A runtime guard refuses any LLM request that carries a known secret value.

## Architecture

One process, a modular monolith (doc 66 D4). The daily paper cycle is composed in `server/apps/v2/index.ts` from five modules. Each reaches another only through a typed interface in `contracts/`, enforced by import rules in `.oxlintrc.json`.

| Module | Directory | Role |
|---|---|---|
| data | `server/apps/v2/data/` | Bars, marks, FX, news, macro calendar, venue sessions and routes, CFD catalogue |
| signal | `server/apps/v2/signal/` | The `Sleeve` contract and every sleeve (debate, arm 2, signals, candidates); the LLM panel, model pins and spend cap |
| risk | `server/apps/v2/risk/` | Loss budget, position size, volume and gross caps, capital config, approval; produces the `RiskApprovedOrder` |
| execution | `server/apps/v2/execution/` | Alpaca and Saxo adapters, broker state, simulated venues; an adapter accepts only a `RiskApprovedOrder` |
| journal | `server/apps/v2/journal/` | The append-only decision journal and the plumbing-fault ledger |

Around the cycle sit `server/apps/v2/signals/` (the signals endpoint), `server/apps/v2/api/` (the dashboard API and the Telegram command poller), reconcile, replay, backup, backtest and the trial ledger. Live state is SQLite, backed up with Litestream. Daily bars are Parquet read through DuckDB. The dead-man's switch is a healthchecks.io ping from the paper cycle, the signals endpoint and the Telegram poller.

## Repository layout

```
client/            Vite + React dashboard
contracts/         Wire model and module interfaces; imports nothing from server/ or client/
server/
  apps/v2/         The v2 composition root, its five modules and its CLIs
  pipeline/        v2-reached survivors in v1-named directories (debate LLM clients, momentum helpers)
  providers/       Bar store, Saxo bars, trading calendar, Alpaca news, the G18-held sentiment code
  shared/          Clock, logging, HTTP, LLM pricing, the SQLite store and migrations
  tools/           Repo gates (citations, CRAP, mutation, live-money gates), backtest statistics, Saxo keep-alive
e2e/               Playwright tests against the dashboard
ops/               launchd jobs and the bar snapshot script
docs/              ADR, specs, research, reviews
```

`client/` and `server/` never import each other; both import `contracts/`. The renames of the `server/pipeline/` survivors wait on David (doc 77 §5.2).

## Running

Requires Node 24+ and npm 10+. Run `npm ci` once. Credentials are read from `.env.local` <!-- cite-exempt: untracked — gitignored local file -->, which is gitignored and never committed.

### v2 commands

| Script | Does |
|---|---|
| `npm run v2:run` | One daily paper cycle (`--dry-run` for the dry-run store, `--date YYYY-MM-DD`) |
| `npm run v2:signals` | The always-on signals endpoint on `127.0.0.1:8789` |
| `npm run v2:dashboard` | The dashboard API on `127.0.0.1:8788` |
| `npm run dev:web` | The dashboard UI on the Vite dev server |
| `npm run v2:telegram` | The Telegram command poller |
| `npm run v2:replay` | Replay a past trading day from the journal |
| `npm run v2:backup`, `npm run v2:restore` | Litestream backup and restore of the paper store |
| `npm run v2:capital` | Set a year's start capital and loss cap |
| `npm run v2:cash-move` | Record a deposit or withdrawal |
| `npm run v2:backtest` | Run a candidate's pre-declared backtest grid |
| `npm run v2:trials` | Print the global trial ledger |
| `npm run v2:entry-offsets`, `npm run v2:cost-fidelity` | Paper-against-model reports |
| `npm run v2:cfd-catalogue` | Refresh the Saxo CFD catalogue |
| `npm run v2:sim-cfd-stop-drill` | The Saxo SIM CFD resting-stop drill |
| `npm run saxo:login`, `npm run saxo:keepalive` | Saxo OAuth login and token keep-alive |
| `npm run bars:snapshot` | Restore the tracked bar-store snapshot that smoke and tests read |

### Scheduled jobs (macOS launchd)

| Job | Runs |
|---|---|
| `ops/launchd/com.samurai.v2-paper.plist` | The paper cycle, weekdays at 07:30 London |
| `ops/launchd/com.samurai.v2-signals.plist` | The signals endpoint, kept alive |
| `ops/launchd/com.samurai.v2-telegram.plist` | The Telegram poller, kept alive |
| `ops/launchd/com.samurai.saxo-keepalive.plist` | Saxo token refresh, on an interval |

Install one with `cp <plist> ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<plist>`. The jobs run whatever is checked out in the main checkout.

### Environment variables

Names only; the values belong in `.env.local` <!-- cite-exempt: untracked — gitignored local file -->.

| Area | Variables |
|---|---|
| Mode | `SAMURAI_MODE` (`paper`; `live` is refused), `SAMURAI_STORE_GUARD` |
| Alpaca | `ALPACA_API_KEY`, `ALPACA_API_SECRET` (paper trading, bars and news); `ALPACA_LIVE_API_KEY`, `ALPACA_LIVE_API_SECRET` |
| Saxo | `SAXO_SIM_APP_KEY`, `SAXO_SIM_APP_SECRET`, `SAXO_LIVE_APP_KEY`, `SAXO_LIVE_APP_SECRET`; optional `SAXO_SIM_GATEWAY`, `SAXO_LIVE_GATEWAY`, and `SAXO_SIM_ACCESS_TOKEN` for the SIM drill |
| LLM | `NOUS_BASE_URL`, and `NOUS_DEBATE_API_KEY` or `NOUS_API_KEY` |
| News | `MARKETAUX_API_KEY` |
| Alerts and Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS`, `SAMURAI_ALERTS` (`log-only`) |
| Dead-man pings | `HEALTHCHECKS_PING_URL`, `HEALTHCHECKS_SIGNALS_PING_URL`, `HEALTHCHECKS_TELEGRAM_PING_URL` |
| Backup | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`, `LITESTREAM_SSE_C_KEY`; optional `LITESTREAM_BIN`, `LITESTREAM_REPLICA_ROOT` |
| Dashboard | `SAMURAI_DASHBOARD_TOKEN`, `HOST`, `V2_DASHBOARD_PORT` |
| Signals endpoint | `V2_SIGNALS_PORT` |
| Research | `SAMURAI_RESEARCH_STORE` (the trial ledger's path) |

Broker keys are trade-only with withdrawals disabled, IP-restricted where the venue allows it. No account data or key leaves in any LLM request.

## Development

| Script | Does |
|---|---|
| `npm test` | The full vitest suite |
| `npm run test:local` | Only what the branch touched (`vitest run --changed origin/main`) |
| `npm run test:watch`, `npm run test:coverage` | Watch mode, coverage |
| `npm run e2e` | Playwright dashboard tests |
| `npm run smoke` | Build, then run the v2 smoke |
| `npm run typecheck` | The server, test, client and e2e projects |
| `npm run build` | Compile the server and contracts, copy migrations, build the UI |
| `npm run lint`, `npm run lint:fix` | oxlint and biome |
| `npm run crap`, `npm run crap:report` | The CRAP gate: 7 on touched functions, `server/apps/v2/` and `contracts/` in full, 15 repo-wide |
| `npm run fallow:dead-code`, `npm run fallow:dupes`, `npm run fallow:boundaries` | Dead code, duplication and boundary checks |
| `npm run mutation:local` | Stryker on changed risk, sizing and loss-budget code |
| `npm run check:citations` | Every backticked path in tracked docs and code resolves |
| `npm run check:live-gates` | The state of the live-money gate issues |
| `npm run precommit` | Lint fix, typecheck, scoped tests and the fallow checks |

GitHub Actions runs the full gates on every PR. Lint, fallow and CRAP rules are never loosened to get a PR green. The standards are in `docs/coding-standards.md` and the stack register in `docs/techstack.md`.

## License

See [LICENSE](LICENSE).
