# CLAUDE.md — Project Briefing

Read this on every session start.

## Project Identity

- **Codename:** Samurai
- **Goal:** Live-money multi-agent trading system covering crypto AND stocks
- **Owner:** David (Deepak)
- **Architecture:** 7-stage pipeline — Analysts → Debate → Trader → Invalidation → Risk → Verdict → Feedback Loop (`invalidation` added 2026-08-05, see `docs/specs/devils-advocate-spec.md`)
- **Status:** Design phase complete (12 components charted, specced, cross-verified; 49 GitHub tickets published). Project scaffolded — TypeScript, npm, vitest, Biome. Implementation not yet started (see `src/` for the skeleton, `docs/specs/` for what fills it in).
- **Language:** TypeScript (Node 22+). Resolved in [ADR-0001](docs/adr/0001-technical-foundation-hybrid.md) — no hard dependency on the Python repos mined for patterns.

## Docs Convention

Read/Write these as the project evolves:

| File | Purpose |
| ------ | --------- |
| `CONTEXT.md` (repo root) | Domain glossary. Terms, relationships, invariants. No implementation details. Update inline as terms resolve. |
| `docs/adr/` | Architecture Decision Records. Only create when (1) hard to reverse, (2) surprising without context, (3) real trade-off. |
| `docs/research/techstack.md` | Libraries, versions, why-chosen. Update as stack choices lock in. |
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

Existing research (DON'T overwrite, reference) — all live under `docs/research/`:

- `docs/research/00-summary.md` — Strategy eval summary
- `docs/research/01-full-report-with-sources.md` — Full strategy eval research
- `docs/research/02-staged-deployment-plan.md` — Stage-gated deployment plan
- `docs/research/trading-agent-handover.md` — Scoping brief (crypto + stocks, UK hosting, Mac server, Kraken/IBKR, ccxt)

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
