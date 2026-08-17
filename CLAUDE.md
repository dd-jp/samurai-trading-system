# CLAUDE.md — Project Briefing

Read this on every session start.

## Project Identity

- **Codename:** Samurai
- **Goal:** Live-money multi-agent trading system for **equities**. Crypto left Samurai's scope on 2026-08-16 — see the Live capital line. This said "covering crypto AND stocks" until 2026-08-17.
- **Owner:** David (Deepak)
- **Edge thesis + horizon:** `CONTEXT.md`'s **debate-as-edge** thesis, at an **intraday, flat-by-close** horizon. Recorded 2026-08-09 by [#632](https://github.com/dd-jp/samurai-trading-system/issues/632) under map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631), and written up as **[ADR-0014](docs/adr/0014-intraday-flat-by-close-horizon.md)**. `docs/research/10-edge-hypothesis.md` and `12-edge-hypothesis-critique.md` are **superseded on horizon** — they describe a weeks-to-months monthly-rebalance strategy and are no longer the product. Do not spec or grill against doc 10's commitments (0.04%/day, −23% drawdown, always-long-basket benchmark, veto-only, the 6→12-instrument widening to 4.60 effective bets).
- **Live capital: Samurai is an equities system, and the £750/£750 split no longer describes its book.** Crypto was **dropped from scope** on 2026-08-16 — David: *"actually drop crypto. we'll create a new system one later for handling crypto trades"* — earned by [#705](https://github.com/dd-jp/samurai-trading-system/issues/705) under map [#703](https://github.com/dd-jp/samurai-trading-system/issues/703) and recorded in **[ADR-0015](docs/adr/0015-live-venue-account-and-book-split.md)**'s 2026-08-16 amendment, with companion amendments to ADR-0014, ADR-0017 (both gates equities-only) and ADR-0018. Equity leg via the **Trading 212 ISA**, restricted to **GBP LSE-listed ETFs/ETCs** ([#659](https://github.com/dd-jp/samurai-trading-system/issues/659)); that restriction, and the venue, are unchanged. **How much capital the equity leg takes is OPEN and must not be settled by inference** — ADR-0018 D5's ~35%/~25% fractions are calibrated to a £750 leg, so doubling to £1,500 doubles the cash at risk per position; ADR-0015 says decide it against the drawdown envelope, not against the fact the money is idle. Tracked by [#800](https://github.com/dd-jp/samurai-trading-system/issues/800) (the code half) downstream of [#798](https://github.com/dd-jp/samurai-trading-system/issues/798). **The SPY/QQQ/AAPL/TSLA default universe is not tradeable live** — instruments are LSE leveraged ETPs per **[ADR-0016](docs/adr/0016-universe-leveraged-etps-ungated.md)**.
- **Architecture:** Analysts → Debate → Trader → [Invalidation] → Risk → Verdict → **Execution**, with a Feedback Loop adjusting analyst weights and risk thresholds post-trade. `invalidation` is specced and NOT built (added 2026-08-05, see `docs/specs/devils-advocate-spec.md`), so the runtime chain is six stages and goes Trader → Risk today. This line previously omitted Execution and listed Feedback Loop as the seventh stage; `RUNTIME_STAGES` and the README are the authority.
- **Repo layout:** `client/` (Vite+React UI) + `server/` (Node: `apps/`, `pipeline/`, `providers/`, `shared/`, `tools/`) + `contracts/` (the wire model both import and neither owns). There is no root `src/`. Neither runtime imports the other; both import `contracts/`.
- **Status:** Implemented and under test — all twelve charted components built, ~2900 tests, end-to-end offline run green (`yarn smoke`). Paper soak has run. Not yet cleared: one real Alpaca paper tick (ADR-0004 §5).
- **Language:** TypeScript (Node 22+). Resolved in [ADR-0001](docs/adr/0001-technical-foundation-hybrid.md) — no hard dependency on the Python repos mined for patterns.

## Docs Convention

Read/Write these as the project evolves:

| File | Purpose |
| ------ | --------- |
| `CONTEXT.md` (repo root) | Domain glossary. Terms, relationships, invariants. No implementation details. Update inline as terms resolve. |
| `docs/adr/` | Architecture Decision Records. Only create when (1) hard to reverse, (2) surprising without context, (3) real trade-off. |
| `docs/techstack.md` | Libraries, versions, why-chosen. Update as stack choices lock in. A living register, not a dated research artifact — moved out of `docs/research/` 2026-08-08. |
| `docs/wayfinder/` | Historical/reference only — earlier maps written as local markdown before the switch to GitHub issues (2026-07-22). New wayfinder maps live as GitHub issues (see Standing Pipeline Rule 1), not here. |
| `docs/specs/` | Synthesized specs (PRDs) per stage, `<stage>-spec.md`. Produced from the wayfinder map via `/to-spec`. |
| `docs/reviews/` | Audit/review reports (code quality, spec conformance, readiness), dated `<topic>-<date>.md`. Findings ranked, prior findings referenced not re-filed. Standards fallout goes to `docs/coding-standards.md` in the same change. **Navigation starts at `docs/reviews/README.md`** (live vs archived, with successor pointers). A report moves to `docs/reviews/archive/` — same file name, never deleted — once every finding is closed or a named successor carries its substance. |

**The intraday product is defined by ADR-0014 through ADR-0018 plus the ADR-0008 §2 amendment.** Read those six before speccing or implementing anything on the trading path — they carry the horizon, the venue and book, the universe and gating rule, the validation gates, the measured cadence economics, and the thresholds/sizing. **[ADR-0018](docs/adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md) (2026-08-10) also amends ADR-0016's expectancy figures, which were wrong in sign** — the leveraged-ETP universe is not profitable on unconditional entry, and ADR-0018 states the bar the signal must clear instead. ADR-0015 carries two amendments: 2026-08-10 recording the crypto fee schedules, and **2026-08-16 removing crypto from Samurai's scope entirely** — read the second before treating any crypto figure in this file or in ADR-0015's body as live.

When in doubt, grep existing docs before writing new ones.

## Standing Pipeline Rules

1. **Wayfinder before implementation — GITHUB ISSUES.** Chart the map as a GitHub issue labeled `wayfinder-map` (or `wayfinder:map`), with its decision/research/prototype tickets as child issues, resolved one at a time with the user (one grilling question at a time). Claim a ticket by assignment before working it; set the board's Status field explicitly on claim and rely on the native "Item closed" project workflow to set Status → Done on close (confirmed reliable as of 2026-07-22). Record each ticket's resolution as a comment, close it, and append a one-line pointer to the map issue's "Decisions so far" section. Close the map issue itself once its frontier is clear (all children resolved) — the map's job is locking decisions, not holding open until the spec is written. Never jump to `/implement` without a resolved wayfinder map and a written spec.
2. **Deep research = background agents + fable-mode synthesis.** See `deep-research-pipeline` skill for the 4-stage flow. Research agents on `openai/o4-mini-deep-research` via OpenRouter. Synthesis on Claude Opus + `fable-mode` skill.
3. **Implementation = `/implement` + `/code-review` + commit.** The `/implement` skill auto-invokes code-review. Let it run. Don't hand-roll the loop.
4. **Fable-mode discipline on ALL implementation.** Read spec fully, plan by risk, verify before reporting done, re-read diff as hostile reviewer before committing.
5. **GitHub also hosts wayfinder maps/tickets now, alongside implementation tickets.** Wayfinder issues are labeled `wayfinder-map` / `wayfinder:research` / `wayfinder:prototype` / `wayfinder:grilling` / `wayfinder:task` so they're distinguishable from implementation tickets (created at `/to-tickets` time, from a completed spec) on the project board (#1) at a glance.
6. **Project Board autolink.** This repo must be autolinked to project #1 so implementation issues (and wayfinder maps/tickets) auto-appear on the board. If `gh project item-add` is needed for ad-hoc additions, do it.
7. **Workflow order:** wayfinder map issue (chart + grill, labeled `wayfinder-map`) → `docs/specs/<stage>-spec.md` (`/to-spec`) → cross-spec verification across all stages → `/to-tickets` (GitHub implementation issues). Specs cite their wayfinder map issue by name+link, not a bare number.

## Rate Limit Rule — HARD STOP

If Claude Code returns a rate-limit / usage-exceeded error:

- **DO NOT** attempt to write implementation code yourself
- **DO NOT** fall back to writing code in Hermes session
- Stop and report to user: "Claude rate limited, waiting for reset"
- Resume when user says go, OR follow cron-retry cadence if configured

This rule is NON-NEGOTIABLE. Never fill the gap with your own code.

## Research Artifacts to Preserve

Existing research (DON'T overwrite, reference) — all live under `docs/research/`. **Navigation starts at `docs/research/README.md`**, which holds the live frontier, the supersession map, and the old→new rename table.

**Naming scheme (consolidated 2026-08-08).** Live docs are `NN-slug.md` with no date suffix and a unique number, banded by track: `00`–`02` foundations (numbers frozen — specs cite them as "docs 00/01/02" by number), `10`s strategy/edge (**CLOSED 2026-08-17, band full** — [#786](https://github.com/dd-jp/samurai-trading-system/issues/786)), `20`s market intelligence, `30`s data vendors, `40`s infra, `50`s **intraday horizon** (the ADR-0014-era product — new strategy research goes here, not the `10`s). Superseded run-records live in `docs/research/archive/` as `YYYY-MM-DD-slug.md`, preserved verbatim — **never deleted**, and raw run logs under `archive/raw/`.

Key docs:

- `docs/research/10-edge-hypothesis.md` — the edge hypothesis (C1/C2/E2/E1), Stage 0 gate
- `docs/research/11-trend-signal-measurement.md` — 10.0y trend vs always-long measurement (+ the `.py` that produced it)
- `docs/research/12-edge-hypothesis-critique.md` — the critique with its audit corrections folded in; use this gate order
- `docs/research/13-stage2-proxy-verdict.md` — the whole Stage 2 chain, terminal KILL on the proxy
- `docs/research/15-crypto-premia-and-llm-layer.md` — crypto/LLM opportunity evaluation
- `docs/research/20-mi-decisions.md` / `30-data-vendor-decisions.md` — the settled MI and data-vendor stacks
- `docs/research/18-intraday-instrument-physics.md` — why a broad tracker cannot support an intraday take-profit; the movers/leveraged-ETP case
- `docs/research/41-tick-latency-economics.md` — measured drift and tail; the tick-interval optimum and ADR-0008's 3.4x cost overestimate
- `docs/research/00-summary.md` / `01-full-report-with-sources.md` / `02-staged-deployment-plan.md` — strategy eval + staged plan

New research goes to `~/hermes-assistant/research/<topic>-<date>-raw.md` (raw) and `<topic>-<date>-analysis.md` (synthesized).

## Broker Plan

**Foundation decided in [ADR-0001](docs/adr/0001-technical-foundation-hybrid.md) — Hybrid. Read it before touching broker/backtest/exec.**

- **MVP path:** **Alpaca paper trading** (execution) + **pybroker** (backtest eval only — cannot host live LLM debate). First end-to-end path; default universe SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD.
- **Long-term crypto: not Samurai's.** Crypto left scope 2026-08-16 (ADR-0015 amendment). The venue analysis — Kraken/Coinbase Advanced via `ccxt`, the Crypto.com App-vs-Exchange finding, the CRO staking arithmetic, the maker-only constraint, the £656 fee cliff — is **preserved as an input the future crypto system inherits**, not withdrawn as wrong. [#671](https://github.com/dd-jp/samurai-trading-system/issues/671) and [#673](https://github.com/dd-jp/samurai-trading-system/issues/673) belong to that future system, not to Samurai's backlog.
- **Long-term stocks:** Interactive Brokers (UK-accessible API); Freetrade/Trading212 for live equities later
- **Abstraction layer mandatory + dual-target from day one.** `BrokerAdapter` = Alpaca (MVP) + ccxt/IBKR (long-term) + Simulated (backtest). Strategy code must not know which broker it's talking to.
- **Reuse posture:** mine `~/trading-system/` repos (swarm-trader, sentient-trader, pybroker) for patterns — **no hard build dependency**. See `/tmp/{swarm,sentient,pybroker}-analysis.md`.
- **Language: TypeScript** (resolved 2026-07-14 — see ADR-0001 Open Questions). No hard dependency on the mined Python repos; the debate substrate is reimplemented, not LangGraph-based.

## Deployment Target

- **Host:** MacBook (always-on). Risks accepted by owner.
- **Risks to mitigate:** macOS auto-updates, power/WiFi drops, lid-close during open position. UPS + wired ethernet + dead-man's-switch alerting recommended.
- **Money graduation:** backtest → paper → tiny live capital. First live = "tuition money."
- **UK tax:** crypto disposals + stock trades = CGT events. Track everything for HMRC.

## Key Constraints

- Real-time WebSocket feeds (crypto) + market-hours scheduler (stocks)
- Persistent state (SQLite/Postgres) — crash-restart must not lose open positions
- Idempotent order IDs, partial-fill handling, rate-limit resilient
- API keys: trade-only permissions, **withdrawals disabled**, IP-whitelisted
- Log every signal, every fill. Track PnL, max drawdown, win rate — **risk-adjusted against a matched control, never return-only against buy-and-hold.** `docs/research/12-edge-hypothesis-critique.md` **D4** rules out return-only comparisons against a risk-targeted stream. The primary control is the recorded thesis's falsifier arm 2 (same name, same ladder, same stop, entry by indicator alone, no LLM); outside benchmarks report return *and* drawdown together. Owned by [#636](https://github.com/dd-jp/samurai-trading-system/issues/636).

## When in doubt

1. Read CONTEXT.md for domain terms
2. Check docs/ for prior decisions
3. Grep codebase for prior art
4. If genuinely ambiguous and blocking — block with clear reason, don't guess

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
