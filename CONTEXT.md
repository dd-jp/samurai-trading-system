# CONTEXT.md — Domain Glossary

Project Samurai. Domain glossary for multi-agent trading system.
No implementation details here. Just terms, relationships, invariants.

---

## Concepts

### Agent Roles (6-stage pipeline)

**Analyst**
An agent persona that examines market data through a specific lens (technical, fundamental, sentiment, etc.). Multiple analysts run in parallel. Each produces a view, not a recommendation. Stateless per tick — holds no memory across ticks. A pure function of its inputs: given data (from Market Intelligence and the Market Data Service) plus its current weight, it emits a weight-blind raw view. Any rolling/windowed features it needs are supplied by upstream data services, never computed and held inside the analyst.

**Trader**
The agent that consolidates analyst views and proposes a concrete action (entry, exit, size, instrument). Operates AFTER debate, not before.

**Risk Manager**
Gate between Trader and Verdict. Applies position-size caps, max drawdown circuit breakers, portfolio exposure limits. Can override Trader's recommendation with a hard "no."

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
**Status: PROPOSED, awaiting David's affirmation** — per `docs/research/02-staged-deployment-plan.md` Stage 0, this is a claim only the strategy's owner can make ("*you* can explain your strategy's expected edge to someone else in under a minute"). Drafted here so the question isn't skipped; treat as open until confirmed.

- **Claimed category:** structural / information-processing advantage — not behavioral-inefficiency (no claim of detecting specific crowd mispricing) and not risk-premium (not harvesting carry/volatility/liquidity premium).
- **Mechanism:** the live pipeline synthesizes multiple independent signal lenses (technical, fundamental, sentiment, news, and geopolitical/macro context via Market Intelligence) *in parallel per tick*, then runs them through an adversarial Debate Engine that surfaces disagreement between lenses rather than averaging it away. The claim is that this catches cases a single-model or discretionary view would either miss (blind to one of the signal classes) or overconfidently smooth over (no adversarial check on its own read).
- **Explicitly NOT part of the claimed edge:** Feedback Loop weight tuning. It is bounded, does not change the underlying market model (per the Feedback Loop glossary entry above), and per `docs/specs/analysts-spec.md`'s explicit exclusion of autonomous adaptation, leaning on it as a source of edge would itself undermine the "economically explainable edge" and PBO-discipline invariants. The synthesis + adversarial-disagreement mechanism must stand on its own; weight tuning only calibrates within it.
- **Falsification test:** if the live pipeline's out-of-sample, post-cost expectancy (Stage 2/3-gated: DSR-significant, PBO ≤ 0.05) is statistically indistinguishable from a single best-performing analyst lens alone, or from the Stage 2 mechanical proxy strategy, the synthesis-plus-debate structure is not adding value beyond noise and cost — the thesis is false and the architecture needs rework, not re-tuning.
- **Which stage gate tests it:** Stage 2/3, run against the **live LLM debate pipeline specifically** — not the mechanical proxy strategy (`docs/wayfinder` / issue #156, dual-SMA crossover). That proxy exists only to validate the Stage 1/2 harness (cost model, DSR/PBO, walk-forward) mechanically; its trend-continuation thesis is unrelated to this one and its results must never be read as evidence for or against this edge claim.

**Overfitting**
Manufacturing high in-sample Sharpe by testing too many configurations against noise. Measured via Probability of Backtest Overfitting (PBO). Kill if PBO > 0.05.

**Sharpe Ratio**
Risk-adjusted return metric. Live system target: ~1.5. Anything > 3-4 for non-HFT = red flag (leverage, hidden tail risk, or overfitting).

**Drawdown**
Peak-to-trough loss. Live system target: max ~20-25%. Full Kelly sizing implies 50-80% drawdowns — never use it.

**Paper Trading**
Live market data, simulated execution. The mandatory middle step between backtest and real money. Must cross at least one volatility regime change before graduation.

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
