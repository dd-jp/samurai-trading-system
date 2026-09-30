# CONTEXT.md — Domain Glossary

Project Samurai v2. Domain glossary: terms, relationships, invariants. No implementation details here.

---

## North Star

Set by David, 2026-09-19, and brought in line with his G rulings of 2026-09-21 (rulings in `docs/research/66-v2-grill-decisions.md`, which wins wherever the two differ).

**Samurai is an autonomous, self-improving trading system that makes a steady net profit (even a small one) over each year, and never loses more than £1,500 net in a year.**

- **Profit** counts only net of every cost and ahead of the matched benchmark: the no-LLM control (arm 2) for the debate sleeve, v2's one sleeve. There is **no daily % target**; losing days are accepted in pursuit of a profitable year.
- **£1,500** is a hard kill-switch on net trading loss from starting capital, across all venues, in GBP, with open positions marked to market. It is a budget per calendar year and resets each year; deposits do not rebase starting capital; GBP/USD moves on the Alpaca balance are excluded, so it measures trading P&L only (G6). Position size halves at −£500 and quarters at −£1,000, and trading halts for the year at −£1,500. A daily loss of 1.0% of starting capital blocks new entries for that day; exits still run. Profits never extend the budget, and neither limit is ever loosened mid-year.
- **Proof comes before money.** A sleeve reaches live capital only after passing the pre-declared gate: DSR ≥ 0.95, PBO ≤ 0.10, a 40% Sharpe haircut, 8–12 weeks of paper trading inside the backtest's 90% band with costs within ±25%, and 4 fault-free weeks. The debate sleeve cannot be backtested honestly (the LLM has seen the history), so its proof is forward paper trading against arm 2: at least 100 closed trades and a one-sided test at 95% (G1). Once the gate passes, the system sends David an approval request on Telegram; a "no" blocks it, and no reply within 24 hours approves it, including for changes that reach live money (G12). Each request, its answer or timeout, and its one-page summary are written to a GitHub issue (G13).
- **Capital is derived, not chosen:** live capital ≤ £1,500 / (backtest max drawdown × 1.5), ramped only while live results stay in band. A live sleeve is demoted to paper when its return leaves the backtest's 95% band for 4 consecutive weeks, or its drawdown exceeds 1.5× the backtest maximum (G7).
- **Self-improving** means learning from mistakes offline: the research loop proposes changes, every variant tried counts as a trial, and a change reaches live only via the gate. Live behaviour changes on its own only through pre-declared, backtested rules and risk that only tightens.
- **Least error margin** means every protective action rests at the broker or is watchdog-backed, never depending on a live process; and backtest, paper and live run the same code.

Superseded goals: the intraday flat-by-close debate-as-edge thesis (ADR-0014) and `docs/v2-vision.md`'s 0.5–2%/day target.

---

## Where the rulings live

The North Star above is the goal in one paragraph. The rulings behind every term below are `docs/research/66-v2-grill-decisions.md` (Q1–Q19, G1–G18, D1–D8, S1–S7), recorded as `docs/adr/0001-samurai-v2.md`; the ordered work is `docs/research/67-v2-plan-and-handoff.md`. v1's vocabulary (intraday, flat-by-close, flatten, 3× ETPs, D5 sizing, paper arms, tick cadence) is gone from this file; its records live at tag `v1-final`. `docs/v1-postmortem.md` holds the six v1 pitfalls that bind v2.

---

## Concepts

### The book

**Sleeve**
One strategy with its own capital share, universe, entry rule, benchmark, book and go-live rule. v2 has two: **Debate**, and on paper since 2026-09-30 **Signals**. The momentum sleeve was dropped on 2026-09-25 after both of its sub-books failed the kill line (doc 70). Its 70% share stays in cash while five rules-based candidate sleeves are tested in turn (doc 66 S1–S7; the fifth, #1861, added 2026-09-28). On paper that whole share now funds the Signals sleeve: external US-long signals, each gated by risk and an LLM veto and judged against a no-veto shadow (doc 66, #1941). A sleeve's share is fixed and pre-declared, never chases the recent winner, and stays in cash until the sleeve passes its go-live rule.

**Debate sleeve**
LLM-debate entry at a **swing** horizon: one debate per screened name per day, pre-open, on daily bars and news, plus sentiment and social as counted trials; holds days to weeks; exits by a venue-resting stop and a time stop. May short, bounded. Benchmark: **arm 2**. Cannot be honestly backtested (the LLM has seen the history), so its proof is forward paper only.

**Debate**
A structured disagreement between three debaters (one model per provider: Sonnet 5, DeepSeek, GPT) settled by a judge (Opus 5.5), producing a directional conviction for one name on one day. Roles rotate across providers daily so a stance is not a provider's bias. Only market data and news leave the system — never account data or keys.

**Shadow book**
A paper book that runs the same sleeve with one input or rule removed, so the input's value is measured rather than assumed: no-macro-gate, no-sentiment, no-social, large-cap-only (debate). Each shadow comparison is a counted **trial**.

**Arm 2**
The debate sleeve's matched control: the same names, the same exit rule, the same stop, with entry by indicator alone and no LLM anywhere in the path. The debate sleeve exists only if it beats arm 2 forward, on paper: at least 100 closed trades and a one-sided test at 95%.

**Universe**
Target: commodities, indices, ETFs and equities, with indices and commodities only through 1× ETFs/ETCs (indices also through Saxo CFDs since 2026-09-28, shorts only) — US large caps at Alpaca plus an LSE ETF/ETC leg at Saxo (being built). Per day ~20 names — ~10 by liquidity rank (a stable core) plus ~10 movers/news names chosen with help from the sentiment score; the movers/news rule is a pre-declared parameter counted as a trial. In the debate sleeve only (and its arm 2 control, which shares its CFD routes; the rules-based candidates stay CFD-free), Saxo CFDs carry shorts on UK and US single stocks, indices and ETFs, and UK single-stock longs; US longs stay at Alpaca and index longs in 1× ETFs (2026-09-28), with a book's gross notional never above its equity. Out of scope: 3× ETPs, UK single stocks other than through CFDs, crypto.

**Small-cap position**
A debate-sleeve long in a name below the large-cap floor. Long-only, half a large-cap trade's risk, capped at a fixed share of the sleeve, excluded below liquidity, price and market-cap floors, and measured against a large-cap-only shadow. The floor and cap numbers are open (G18).

**Short position**
The debate sleeve and its arm 2 control only (arm 2 shorts through the same Saxo CFD routes, 2026-09-29); the rules-based candidate sleeves stay long-only and CFD-free. At Alpaca: easy-to-borrow large caps, sized so a +30% gap costs no more than about £150. At Saxo: 1× inverse ETFs or CFDs (2026-09-28); CFD leverage is capped at 1× book equity and a CFD short is sized so a +30% gap costs no more than about £45; the other CFD bounds are open.

**Macro event day**
A day with a high-impact release (FOMC, US CPI, NFP, BoE rate decision, UK CPI). The debate sleeve enters at half size; exits are unaffected; the gate is a counted trial against a no-gate shadow.

### The loss budget

**Loss budget**
£1,500 of net trading loss per calendar year, measured from **start capital** across both venues in GBP with open positions marked to market. Resets on 1 January. Deposits do not rebase start capital. GBP/USD moves on the Alpaca balance are excluded: it measures trading P&L only. Profits never extend it. Never loosened mid-year — a rule code refuses, not a convention.

**Size step**
The budget's response to loss: −£500 halves position size, −£1,000 quarters it, −£1,500 halts trading for the rest of the year. The backtest runs with the size steps inside it so the predicted band already reflects them.

**Daily cap**
A loss of 1.0% of start capital in one day blocks new entries for that day. Exits still run.

**Sleeve share**
Each sleeve's book holds its capital share of start capital, and its budget, size steps and daily cap are the same share of the account's (debate 30%: £450 a year, steps at −£150/−£300, £6 a day on a £2,000 start). The sleeves' caps together never exceed the account's, on paper and live.

**Halt**
The state after −£1,500: no new entries until the next calendar year. Protective exits keep running.

**Start capital**
The capital the budget and the daily cap are measured from. Deposits do not rebase it. What it is at each 1 January reset is open (G6, loss-budget spec).

**Capital ceiling**
Live capital ≤ £1,500 / (backtest maximum drawdown × 1.5). Capital is derived from the backtest, never chosen. Live starts at the floor and ramps only while live stays in band.

### Proof

**Trial**
One configuration tried, anywhere: a backtest variant, a shadow comparison, a model swap, a stop on or off. Every trial increments a global, append-only **trial counter**, and DSR is deflated over all of them. A pinned model version changing is a new trial and restarts that sleeve's paper evaluation.

**Gate**
The pre-declared conditions a sleeve passes before live capital: backtest beats its benchmark after a 40% Sharpe haircut with **DSR ≥ 0.95** and **PBO ≤ 0.10** on 10+ years; 8–12 weeks of paper **in band**; 4 consecutive **fault-free weeks**; then the **approval request**. The debate sleeve substitutes its arm-2 forward test for the backtest clause.

**Haircut**
The 40% reduction applied to a backtest Sharpe before it is compared to the benchmark, standing in for the out-of-sample decay real strategies show.

**Band**
The backtest's predictive interval for a live or paper window. Paper is **in band** when its return sits inside the 90% band and its realised costs are within ±25% of modelled. Live is demoted when it leaves the 95% band for 4 consecutive weeks.

**Fault-free week**
A week with zero plumbing faults: no missed stop, no reconcile mismatch, no stuck order. Counted from the plumbing-fault ledger, not from memory.

**Benchmark**
What a sleeve must beat, risk-matched: arm 2 for the debate sleeve. Return-only comparisons are never used.

**Paper**
Live data, simulated fills, one separate book per sleeve plus its shadows. Saxo paper is a simulated adapter filling at Saxo bid/ask at the live tariff (0.08% per side, no minimum); Alpaca paper is Alpaca's own. Paper profit is not evidence of edge; paper gates on fidelity to the backtest.

**Promotion**
A sleeve or change moving paper → live after the gate and the approval request. **Demotion** is the reverse: live → paper on leaving the 95% band for 4 weeks or on drawdown above 1.5× the backtest maximum.

**Approval request**
The Telegram message the system sends David once the gate passes for anything that reaches live money (new sleeve, changed rule, capital increase), carrying a one-page summary (the change, the haircut backtest, paper fidelity, the worst case against £1,500). A "no" blocks it. No reply within 24 hours approves it. The request, the reply or timeout, and the summary are written to a GitHub issue. There is no sign-off screen. Whether the same rule covers a build session's STOP is open.

### Self-improvement

**Research loop**
The offline process that reads the **trade journal** and error log, proposes rule or parameter changes, walk-forward tests them as counted trials, and submits survivors to the gate. Its design is open (G11); it is built last, once a journal exists.

**Adaptation rule**
The only way live behaviour changes without a promotion: a pre-declared, backtested rule (volatility scaling, trend filter, sleeve demotion) or a risk change that only tightens. Everything else on live is frozen between promotions.

**Trade journal**
Append-only record of every decision — entry, no-entry, cap, skip, exit — with its inputs and reason, plus the **LLM trace** (prompt version, inputs, output, cost) joined to the resulting trade. Any past day must replay from it to identical decisions, with LLM outputs replayed rather than re-called.

### Protection

**Venue-resting stop**
A stop order held at the broker, so it fires whether or not Samurai is running. Every position has one. Nothing mandatory depends on a live process being awake at an instant.

**Watchdog**
The external dead-man's switch and the Saxo token-refresh/wake job: silence from the system is itself an alert, and a token never expires unnoticed.

**Reconcile**
Every run compares broker positions and cash with the store; any mismatch halts entries and alerts.

**Plumbing-fault ledger**
The log of every missed stop, reconcile mismatch or stuck order. The gate's fault-free weeks are counted from it.

**Tax log**
Per-disposal record in GBP at the day's rate with the FX rate used, share-matched (same-day and 30-day rules), for a Saxo GIA and an Alpaca account: disposals are CGT events. W-8BEN on the US side.

### Venues and host

**Venue**
Saxo Capital Markets UK (GIA, OpenAPI) for LSE 1× ETFs/ETCs; Alpaca (live account, GBP wired once, trading in USD) for US names. Both from day one, paper first. Each sleeve's venue split follows its instruments.

**Host**
An always-on MacBook with the watchdog beside it; a cloud VM if paper ever records a downtime fault.

**Autonomy**
Research, backtests, promotion to paper and risk tightening need nobody. Only what reaches live money passes through the approval request.

---

## Relationships

- Daily bars + news (+ sentiment, social, macro calendar as trials) → Debate → conviction → Debate sleeve entry, measured against arm 2 and its shadows
- Every entry → venue-resting stop (+ time stop for debate) at the broker
- Loss budget → size step / daily cap / halt → applies to every entry; never to exits
- Trade journal → Research loop → trial → gate → paper → approval request → live
- Live → band check weekly → demotion to paper when out of band
- Backtest, paper and live run the same TypeScript code

---

## Invariants

1. Net loss in a calendar year never exceeds £1,500; the budget and the daily cap are never loosened mid-year.
2. No live capital before the gate passes and the approval request has run its course; capital is derived from the backtest's drawdown.
3. Every protective action is venue-resting or watchdog-backed, never tick-dependent.
4. Every windowed data read carries a tested coverage invariant.
5. Every trial is counted; every decision, fill and LLM call is journalled; any past day replays to the same decisions.
6. Paper profit is not evidence of edge; only fidelity to the backtest (in band) is.
7. One implementation of every strategy, in TypeScript, runs in backtest, paper and live.
8. Broker keys are trade-only, withdrawals disabled, IP-restricted where the venue offers it; no account data or key leaves in any LLM request, and an LLM request carrying a known secret value is refused before it is sent.
9. Crash-restart loses no position: the broker is the source of truth and every run reconciles against it.
10. Rate-limit errors are a hard stop; no agent proceeds.
