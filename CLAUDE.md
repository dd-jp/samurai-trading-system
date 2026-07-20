# CLAUDE.md — Project Briefing

Read this on every session start.

## Project Identity

- **Codename:** Samurai
- **Goal:** Live-money multi-agent trading system covering crypto AND stocks
- **Owner:** David (Deepak)
- **Architecture:** 6-stage pipeline — Analysts → Debate → Trader → Risk → Verdict → Feedback Loop
- **Status:** Design phase complete (12 components charted, specced, cross-verified; 49 GitHub tickets published). Project scaffolded — TypeScript, npm, vitest, Biome. Implementation not yet started (see `src/` for the skeleton, `docs/specs/` for what fills it in).
- **Language:** TypeScript (Node 22+). Resolved in [ADR-0001](docs/adr/0001-technical-foundation-hybrid.md) — no hard dependency on the Python repos mined for patterns.

## Docs Convention

Read/Write these as the project evolves:

| File | Purpose |
|------|---------|
| `CONTEXT.md` (repo root) | Domain glossary. Terms, relationships, invariants. No implementation details. Update inline as terms resolve. |
| `docs/adr/` | Architecture Decision Records. Only create when (1) hard to reverse, (2) surprising without context, (3) real trade-off. |
| `docs/research/techstack.md` | Libraries, versions, why-chosen. Update as stack choices lock in. |
| `docs/wayfinder/` | **Wayfinder maps + grilling decisions live here as local markdown** (`<stage>-map.md`): destination, decisions-so-far, open frontier, out-of-scope. This is the canonical home for design/planning — NOT GitHub issues. |
| `docs/specs/` | Synthesized specs (PRDs) per stage, `<stage>-spec.md`. Produced from the wayfinder map via `/to-spec`. |

When in doubt, grep existing docs before writing new ones.

## Standing Pipeline Rules

1. **Wayfinder before implementation — LOCAL.** Chart the map and resolve its frontier in `docs/wayfinder/<stage>-map.md` (local markdown, one grilling question at a time with the user). Do NOT create GitHub issues for maps or grilling questions. Never jump to `/implement` without a resolved wayfinder map and a written spec.
2. **Deep research = background agents + fable-mode synthesis.** See `deep-research-pipeline` skill for the 4-stage flow. Research agents on `openai/o4-mini-deep-research` via OpenRouter. Synthesis on Claude Opus + `fable-mode` skill.
3. **Implementation = `/implement` + `/code-review` + commit.** The `/implement` skill auto-invokes code-review. Let it run. Don't hand-roll the loop.
4. **Fable-mode discipline on ALL implementation.** Read spec fully, plan by risk, verify before reporting done, re-read diff as hostile reviewer before committing.
5. **GitHub = implementation tickets only.** GitHub issues are created ONLY at `/to-tickets` time, from a completed spec. The project board (#1) therefore shows only real, actionable implementation tickets + PRs — never design/planning churn. Board auto-updates via native GitHub workflows (closed → Done, PR review → In Review, etc).
6. **Project Board autolink.** This repo must be autolinked to project #1 so implementation issues auto-appear on the board. If `gh project item-add` is needed for ad-hoc additions, do it.
7. **Workflow order:** `docs/wayfinder/<stage>-map.md` (chart + grill) → `docs/specs/<stage>-spec.md` (`/to-spec`) → cross-spec verification across all stages → `/to-tickets` (GitHub implementation issues). Specs cite their local wayfinder map, not issue numbers.

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
