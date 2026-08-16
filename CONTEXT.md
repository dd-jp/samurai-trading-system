# CONTEXT.md — Domain Glossary

Project Samurai. Domain glossary for multi-agent trading system.
No implementation details here. Just terms, relationships, invariants.

---

## Concepts

### Agent Roles (7-stage pipeline)

**Analyst**
An agent persona that examines market data through a specific lens (technical, fundamental, sentiment, etc.). Multiple analysts run in parallel. Each produces a view, not a recommendation. Stateless per tick — holds no memory across ticks. A pure function of its inputs: given data (from Market Intelligence and the Market Data Service) plus its current weight, it emits a weight-blind raw view. Any rolling/windowed features it needs are supplied by upstream data services, never computed and held inside the analyst.

**Trader**
The agent that consolidates analyst views and proposes a concrete action (entry, exit, size, instrument). Operates AFTER debate, not before.

**Invalidation** (also: **Devil's Advocate**)
Stage between Trader and Risk. Runs only on an actionable `entry`/`scale_in` intent. Reads the debate's thesis and states 3-5 typed, machine-checkable **invalidation conditions** — the conditions under which the thesis is *wrong* — each bound to a service that already exists. It then evaluates its own conditions against live data and hands the result to Risk. Distinct from the Bear persona, which argues the pessimistic case in prose: the insight overlaps, but only structure is checkable. The LLM names what to check; deterministic code does the checking, so a model cannot produce a breach — only propose a condition.

**Invalidation condition**
A predicate: an observable (indicator, mark, bar window, or market-intelligence count), a comparator, and a numeric threshold, plus free-text rationale. Carries **no** severity, weight, or confidence. Evaluates tri-state — `breached` / `not_breached` / `unevaluable` — where `unevaluable` is derived mechanically from stale context or insufficient bars, never judged. A condition **already breached at entry** means the thesis was falsified before the trade was placed.

**Risk Manager**
Gate between Invalidation and Verdict. Applies position-size caps, max drawdown circuit breakers, portfolio exposure limits. Can override Trader's recommendation with a hard "no." Also hard-rejects when the invalidation stage reports a non-empty breached list.

**Verdict**
The final go/no-go decision after Risk approval. Triggers execution.

**Debate Engine**
Mediates between conflicting analyst views before the Trader consolidates. Surfaces disagreements rather than averaging them away.

**Feedback Loop**
Post-execution review. Compares predicted outcome vs actual. Adjusts analyst weights, strategy parameters, risk thresholds. Does NOT change the underlying market model.

### Trading Concepts

**Expectancy**
E[trade] = (P_win × Avg_win) − (P_loss × Avg_loss) − Costs. The north star metric. Positive = edge. Zero/negative = ruin, faster or slower depending on frequency.

**Edge**
A statistical advantage that persists after costs, decay, and multiple-testing correction. Must be economically explainable (behavioral inefficiency, risk premium, or structural/liquidity advantage).

**Samurai's Edge Thesis (Stage 0)**
**Status: RECORDED** — affirmed by David 2026-08-09, resolving [#632](https://github.com/dd-jp/samurai-trading-system/issues/632) under wayfinder map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631). Per `docs/research/02-staged-deployment-plan.md` Stage 0, this is a claim only the strategy's owner can make ("*you* can explain your strategy's expected edge to someone else in under a minute"). Stage 0 requires a *stated, falsifiable* hypothesis, not a validated one — validation is Stage 2/3's job and is still open.

> **How this was decided, and what it supersedes (2026-08-09).** Three theses were live: this one, `docs/research/10-edge-hypothesis.md`'s risk-premium harvest, and `docs/research/12-edge-hypothesis-critique.md`'s long-gamma correction of doc 10. **The ruling turned on horizon, not on the doc-10-vs-doc-12 merits.** David requires **intraday / day trading**; docs 10 and 11 measured a monthly-rebalance, 63-day-lookback strategy at a weeks-to-months horizon (doc 11 lines 16/18, doc 10 Box 3), so doc 11's ten years of daily-bar evidence does not transfer. Both are **superseded on horizon, not on quality** — their measurements, candidate eliminations and cost arithmetic stand and remain citable. Doc 12's gate 2 architecture ADR therefore resolves to **"neither"**: the measured portfolio is not the thing we build.
>
> **Stated open risk.** This thesis rests on the debate layer selecting a name that rises. [#625](https://github.com/dd-jp/samurai-trading-system/issues/625) measured that layer at **96 debates and 0 trades** — a conviction ceiling of 0.5478 against a 0.55 floor. There is **no observed win rate for the selector at all**, and #625 is a prerequisite to measuring one.

- **Claimed category:** structural / information-processing advantage — not behavioral-inefficiency (no claim of detecting specific crowd mispricing) and not risk-premium (not harvesting carry/volatility/liquidity premium).
- **Horizon:** **intraday — single session, flat by market close, no overnight carry.** Recorded 2026-08-09 (#632); the thesis previously stated no horizon. Overnight carry is excluded for the reason doc 10 used to drop its candidate E2: `time_in_force.stocks = 'day'` (`DEFAULT_TRADER_CONFIG`) leaves the overnight lot without a stop.
  - **Amended 2026-08-14 ([#667](https://github.com/dd-jp/samurai-trading-system/issues/667)): flat-by-close binds the EQUITY leg only.** The crypto leg has **no time flatten** — it is held by the venue-side stop and the tranche ladder alone. The rule's whole purpose is that a closed market cannot fill a stop, and that risk does not exist on a 24/7 venue whose bracket leg stays live; a midnight-UTC flatten would be an accounting convention masquerading as a trading instruction. Enforced structurally rather than by convention: `TradingCalendar.sessionEnd` returns `Date | null`, `AlwaysOpenCalendar` returns `null`, and the Trader's flatten declines to act on a null boundary ([#668](https://github.com/dd-jp/samurai-trading-system/issues/668)). **Consequence for costs:** the crypto leg trades a **365-day** calendar, so at ADR-0014's recorded floor of one crypto trade per day it clears **$57.9K/month — Crypto.com tier 3**, which is the side of the $50K boundary ADR-0015's 2026-08-10 amendment left open. `docs/research/19-crypto-venue-fees.md`'s tier-3 branch is therefore the live one, and #660's £750/£750 split is unaffected.
- **Mechanism:** the live pipeline synthesizes multiple independent signal lenses (technical, fundamental, sentiment, news, and geopolitical/macro context via Market Intelligence) *in parallel per tick*, then runs them through an adversarial Debate Engine that surfaces disagreement between lenses rather than averaging it away. The claim is that this catches cases a single-model or discretionary view would either miss (blind to one of the signal classes) or overconfidently smooth over (no adversarial check on its own read).
- **Explicitly NOT part of the claimed edge:** Feedback Loop weight tuning. It is bounded, does not change the underlying market model (per the Feedback Loop glossary entry above), and per `docs/specs/analysts-spec.md`'s explicit exclusion of autonomous adaptation, leaning on it as a source of edge would itself undermine the "economically explainable edge" and PBO-discipline invariants. The synthesis + adversarial-disagreement mechanism must stand on its own; weight tuning only calibrates within it.
- **Falsification test:** if the live pipeline's out-of-sample, post-cost expectancy (Stage 2/3-gated: DSR-significant, PBO ≤ 0.05) is statistically indistinguishable from **either control arm** below, the synthesis-plus-debate structure is not adding value beyond noise and cost — the thesis is false and the architecture needs rework, not re-tuning.
  - **Arm 1 — a single best-performing analyst lens alone.** Unchanged.
  - **Arm 2 — the same name selection, the same profit ladder, the same stop, with entry by technical indicator alone and no LLM in the path.** *Restated 2026-08-09 (#632).* Arm 2 previously named the Stage 2 mechanical proxy (dual-SMA crossover on daily bars, issue #156); that control is the wrong horizon for an intraday thesis and no longer applies. The replacement isolates precisely what the news/sentiment/debate layer contributes over a technicals-only rule, and — unlike the old arm — it is runnable on the live system, which also answers doc 12's **D6** ("the LLM ablation is unrunnable in both directions").
- **Which stage gate tests it:** Stage 2/3, run against the **live LLM debate pipeline specifically**, at the intraday horizon, against arm 2 as the matched control. The old Stage 2 mechanical proxy (issue #156) is not a control for this thesis and its results must never be read as evidence for or against this edge claim.

**Overfitting**
Manufacturing high in-sample Sharpe by testing too many configurations against noise. Measured via Probability of Backtest Overfitting (PBO). Kill if PBO > 0.05.

**Sharpe Ratio**
Risk-adjusted return metric. Live system target: ~1.5. Anything > 3-4 for non-HFT = red flag (leverage, hidden tail risk, or overfitting).

**Drawdown**
Peak-to-trough loss. Live system target: max ~20-25%. Full Kelly sizing implies 50-80% drawdowns — never use it.

> **Restated 2026-08-10 by [ADR-0018](docs/adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md) — this is a sizing constraint, not an outcome to accept.** Measured on a drift-removed series (zero edge assumed), the intraday universe's own volatility envelope at full £750 deployment is **55.6% for a 3× index ETP and 88.0% for a 3× single-stock ETP** — 2.2× to 3.5× outside the tolerance above, before any edge exists. Holding 20–25% therefore fixes position size: **~35% of the equity leg for index ETPs (23.1% drawdown, inside the band), ~25% for single-stock ETPs (26.2%, ~1.2 pp above it — an overshoot ADR-0018 Decision 5 accepts explicitly rather than sizes away)**. The superseded −23% *pre-accepted* drawdown belonged to doc 10's weeks-to-months strategy and is not a commitment of this system.

> **Re-derivation history (2026-08-09, #632 → resolved 2026-08-10).** The ~20-25% figure was originally set alongside `docs/research/10-edge-hypothesis.md`'s −23% pre-accepted drawdown, which belongs to the superseded weeks-to-months horizon, and for a day it carried no intraday derivation at all. [#653](https://github.com/dd-jp/samurai-trading-system/issues/653) closed that gap — the restated block above IS its result, so the tolerance is no longer merely inherited. **Still outstanding:** `docs/specs/risk-manager-spec.md` repeats the figure under its own sizing section together with the now-obsolete "inherited, not re-validated" caveat, and no Risk Manager rule enforces the per-subclass fractions.

**Paper Trading**
Live market data, simulated execution. The mandatory middle step between backtest and real money. Must cross at least one volatility regime change before graduation.

> **Open conflict (2026-08-09, [#661](https://github.com/dd-jp/samurai-trading-system/issues/661)).** David's plan is a **14-day** paper run before deciding live. A fortnight is unlikely to contain a volatility regime change, so it does not satisfy the invariant above — which must be amended deliberately rather than broken by omission. #661's resolution keeps the fortnight as an **operational** pass/fail gate (do trades execute, does spend stay in budget, do stops and the flatten fire) and moves the thesis gate to an **expectancy sign test at ~126 trades (~3 months)**, with the graduation decision sitting at the later gate. Note also what paper cannot measure at all: maker fill rates, stop slippage, and the exchange fee-tier ramp — all three optimistic, so paper expectancy is an **upper bound**.

### Infrastructure

**Broker Abstraction Layer**
Interface that hides which broker (Kraken, IBKR, etc.) the strategy is talking to. Strategy code sees orders/fills/positions. Broker code sees API calls. Never mix them.

**Idempotent Order**
An order that, when submitted multiple times (due to retry), results in exactly one fill. Critical for crash-restart safety.

**Circuit Breaker**
Hard stop when a metric crosses a threshold. Max daily drawdown, max position size, max consecutive losses. Must be testable without live market data.

**Dead-Man's Switch**
Alert system where silence itself triggers notification. If the bot stops reporting at its expected cadence, Telegram/email fires. Catches crash, network drop, zombie process.

**Market Intelligence**
The news/sentiment half of the Stage 0 data layer. Runs specialized agents (professional news, social sentiment, and geopolitical/macro intelligence via WorldMonitor), detects cross-source convergence/triangulation/absence signals via an N-source convergence engine (ADR-0002), and delivers structured intelligence to analysts. Does not cover price/OHLCV — that is the Market Data Service.

**Market Data Service**
A dedicated Stage 0-level data layer, parallel to Market Intelligence, that serves price OHLCV plus precomputed technical indicators (moving averages, RSI, etc.) to analysts. Market Intelligence covers news/sentiment intelligence only and does NOT serve price data — the Market Data Service fills that gap. Centralizes point-in-time indicator computation so analysts stay stateless. Needs its own wayfinder map before implementation.

**Universe Selector**
The pre-session selector: an out-of-session batch job that ranks a checked-in candidate pool on **one** axis — the reach rate at the frozen bracket, measured on each row's `screening_instrument` — and writes a **watchlist** of 5–10 instruments for the next session. It runs at **22:15 London** on completed US daily bars, keyed to the next *trading* day. The Orchestrator's **active list** becomes that watchlist plus any instrument holding an open position (pinned regardless of rank), swapped only at a session boundary. *(Amended 2026-08-16: the pool is an LSE leveraged-ETP mapping, not S&P 100; the three opportunity axes — volatility, gap/momentum, range position — are withdrawn, since a single objective-aligned axis contributes zero trials to the PBO accounting; and the crypto component is gone with crypto's removal from scope.)* **Deliberately not called "Stage 0"** even though `docs/research/17-universe-manipulation-guardrails.md` uses that label: Stage 0 is the *data layer* (Market Intelligence + Market Data Service, above), and the Universe Selector is not a pipeline stage at all — it runs between sessions and produces configuration for the next one rather than a decision within a tick. See `docs/specs/universe-selector-spec.md`.

**Watchlist**
The Universe Selector's output — the ranked shortlist of equities the next session is worth spending tick budget on. Distinct from the **candidate pool** (the static, checked-in set of names Samurai will *ever* trade, which the market-data routing map is built over) and from the **active list** (what the Orchestrator actually iterates: watchlist + pinned held positions — two additive components, not three, since crypto left scope). A stale or empty watchlist falls back to the pool rows flagged `fallback_default` and alerts — never to an empty list, and never to `DEFAULT_UNIVERSE`, whose SPY/QQQ/AAPL/TSLA are untradeable on the live venue.

**Order Intent**
The Trader's output — a single broker-agnostic bracket (instrument, side, size, entry, stop, target, time-in-force) plus metadata (provenance, sizing decomposition, cosine precedent). Carries a deterministic idempotency key = hash(instrument + bar). The Risk Manager vets/modifies it; the broker abstraction expands it into native multi-leg orders at Execution.

**Shared State Store**
One SQLite database holding the system's durable state — open positions (reconciled against the broker as source of truth), analyst weights (owned by the Feedback Loop), and the cosine setup store. Read by multiple stages, written by their owners. Satisfies the crash-restart invariant.

**Portfolio-Accounting View**
A small module that computes equity (cash + mark-to-market of open positions), peak-to-trough drawdown, and current exposure from the Shared State Store. The Risk Manager reads it synchronously (off the Feedback Loop's async path) to evaluate caps and circuit breakers.

---

## Relationships

- Market Intelligence (news/sentiment) + Market Data Service (OHLCV/indicators) feed into → Analysts
- Analysts feed into → Debate Engine
- Debate Engine applies analyst weights (read from shared SQLite, owned by Feedback Loop) when consolidating raw views
- Debate Engine feeds into → Trader
- Trader proposes → Risk Manager
- Risk Manager gates → Verdict
- Verdict triggers → Execution (idempotent orders)
- Execution produces fills → Feedback Loop
- Feedback Loop adjusts → Analyst weights, strategy params, risk thresholds

---

## Invariants

1. Expectancy > 0 before any live money
2. Real money graduation: backtest → paper → tiny live
3. API keys: trade-only, no withdrawals, IP-whitelisted
4. Every signal logged, every fill logged
5. Crash-restart must not lose open positions
6. Rate-limit errors = HARD STOP, no agent may proceed
