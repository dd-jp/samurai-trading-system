# CLAUDE.md — Project Briefing

Read this on every session start.

## Project Identity

- **Codename:** Samurai
- **Goal:** Live-money multi-agent trading system covering crypto AND stocks
- **Owner:** David (Deepak)
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
| `docs/reviews/` | Audit/review reports (code quality, spec conformance, readiness), dated `<topic>-<date>.md`. Findings ranked, prior findings referenced not re-filed. Standards fallout goes to `docs/coding-standards.md` in the same change. |

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

**Naming scheme (consolidated 2026-08-08).** Live docs are `NN-slug.md` with no date suffix and a unique number, banded by track: `00`–`02` foundations (numbers frozen — specs cite them as "docs 00/01/02" by number), `10`s strategy/edge, `20`s market intelligence, `30`s data vendors, `40`s infra. Superseded run-records live in `docs/research/archive/` as `YYYY-MM-DD-slug.md`, preserved verbatim — **never deleted**, and raw run logs under `archive/raw/`.

Key docs:
- `docs/research/10-edge-hypothesis.md` — the edge hypothesis (C1/C2/E2/E1), Stage 0 gate
- `docs/research/11-trend-signal-measurement.md` — 10.0y trend vs always-long measurement (+ the `.py` that produced it)
- `docs/research/12-edge-hypothesis-critique.md` — the critique with its audit corrections folded in; use this gate order
- `docs/research/13-stage2-proxy-verdict.md` — the whole Stage 2 chain, terminal KILL on the proxy
- `docs/research/15-crypto-premia-and-llm-layer.md` — crypto/LLM opportunity evaluation
- `docs/research/20-mi-decisions.md` / `30-data-vendor-decisions.md` — the settled MI and data-vendor stacks
- `docs/research/00-summary.md` / `01-full-report-with-sources.md` / `02-staged-deployment-plan.md` — strategy eval + staged plan

New research goes to `~/hermes-assistant/research/<topic>-<date>-raw.md` (raw) and `<topic>-<date>-analysis.md` (synthesized).

## Broker Plan

**Foundation decided in [ADR-0001](docs/adr/0001-technical-foundation-hybrid.md) — Hybrid. Read it before touching broker/backtest/exec.**

- **MVP path:** **Alpaca paper trading** (execution) + **pybroker** (backtest eval only — cannot host live LLM debate). First end-to-end path; default universe SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD.
- **Long-term crypto:** Kraken or Coinbase Advanced via `ccxt` (unified API)
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
- Log every signal, every fill. Track PnL, max drawdown, win rate vs buy-and-hold

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
