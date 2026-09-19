# 65 — Next steps: what docs 61/62/63 plus the live paper book say to do

**Status:** PLAN (2026-09-19). **Implements nothing and decides nothing.** The fork in §5 is David's decision. Draws on [`61-five-topics-safest-max-profit.md`](61-five-topics-safest-max-profit.md), [`62-rewrite-safer-profitable-bot.md`](62-rewrite-safer-profitable-bot.md), [`63-qanat-adaptation.md`](63-qanat-adaptation.md), docs [11](11-trend-signal-measurement.md) and [13](13-stage2-proxy-verdict.md), and a read-only query of `data/samurai-paper.sqlite` taken 2026-09-19.

**Labels.** **[verified]** means read from the repo, the DB, or GitHub during this pass. **[derived]** means arithmetic on verified inputs. **[inferred]** means an interpretation. **[assumed]** means a modelling choice.

---

## 1. Evidence that changes the premise

**#625 is closed, and the system now trades** **[verified: `gh issue view 625`, closed 2026-08-15]**. Docs 61 and 63 both treat "#625: no win rate" as the upstream blocker. That premise is stale. The book now has a denominator, but it is too small, and there is a bigger problem than its size:

| Arm | Closed trades | Wins | Net PnL | Avg notional/trade | Window |
|---|---|---|---|---|---|
| live (LLM debate) | 7 | 2 (28.6%) | **−£112.49** | £166 (4 priced) / **£2,488 (3 unpriced)** | 2026-08-26 → 09-18 |
| control (Arm 2, no LLM) | 79 | 37 (46.8%) | **+£799.08** | **£1,457** | 2026-09-03 → 09-18 |

**[verified: `closed_trades`]**

Three defects mean this table cannot be read as a result yet:

1. **Notional exceeds the book.** ADR-0018 D5 caps per-position cash at £350/£250 of a £1,000 book. The control averages £1,457 per trade. Three live trades averaged £2,488, and those are also the three with `modelled_cost_charged = 0`. **[verified]**
2. **The two stores disagree on the control's sign.** `closed_trades` sums the control to +£799. The latest `arm_comparison_samples` row (window 08-20 → 09-19, basis £1,270) reports control return **−18.8%** with **50.2% max drawdown**. **[verified]** At least one of them is wrong.
3. **The control's profit comes from a few tail trades on names outside the live universe.** MSTR, MARA and COIN (14 trades) contribute £1,162, which is more than the control's whole net. The best single trade is +£518 and the worst is −£382, both on a £1,000 book. The instruments are US single stocks on Alpaca paper, not the LSE ETPs the live product is meant to trade. **[verified]**

**Sample size needed** **[derived]**: detecting accuracy edge *d* over 50% at one-sided α = 0.05 and 80% power needs n ≈ (1.645 + 0.842)² × 0.25 / d².

- *d* = +8.18 pp (index bar): **~231 trades**
- *d* = +4.66 pp (single-stock bar): **~712 trades**

The live arm closed 7 trades in about 3.5 weeks, roughly 2 a week. At that rate the index bar takes **~2 years** and the single-stock bar **~7 years**. **At the current trade rate, the intraday debate thesis cannot be measured within any horizon that matters.** That is the finding this plan is built around.

## 2. What the three docs agree on, and the one conflict

**Agreement.** The binding constraint is directional accuracy per paid round trip, not infrastructure. Every doc says to measure against Arm 2 before importing anything.

**Conflict.** On 2026-09-18 I answered David's ground-up question with "keep the six stages, rewrite the plumbing" (Python, event sourcing, Postgres/Timescale). Doc 62 says the opposite: keep the plumbing and rewrite the product. **Doc 62 is right, and I am withdrawing my earlier answer.** A chassis rewrite costs months and adds zero percentage points of accuracy. ADR-0001 also still bars Python in the real repo. **The chassis rewrite is deferred indefinitely.** Reconsider it only if a strategy clears its gate and the chassis turns out to be what blocks it.

**The weak point in doc 62's fork.** Its edge is weekly binary TSMOM, long or flat, vol-targeted, on 1× ETFs. That is the same signal family doc 11 already measured: **+0.17 Sharpe over always-long on the same basket, paired t = 0.15, "that is nothing"** **[verified: doc 11 l.3]**. Doc 11's only surviving claim was leverage efficiency at a target return, and doc 62 gives that up by going 1×. The quoted "Sharpe ~0.5–0.8 net" is an assertion that doc 11 already failed to support unlevered. What differs is cadence (weekly vs monthly), the universe, and the crash-brake. So this is a strong negative prior, not a kill. Doc 11 l.154 sets the bar for everything below: *the control is always-long on the same basket at the same vol target, not SPY. Nothing has cleared it yet.*

## 3. Plan

Each step is written as `step => verify: how`. The steps are ordered by what they unblock.

### Step 0 — Fix the scoreboard (admissible now, no decision needed)

No branch can be judged until the arm numbers can be trusted.

- 0a. Reconcile `closed_trades` with `arm_comparison_samples` for the control arm over the same window, and find which one is wrong. => verify: one SQL query reproduces the stored `control_return_pct` from `closed_trades`, or the defect is named in an issue.
- 0b. Find out why the control arm sizes above D5 and why 3 live lots skipped the cost model. => verify: every lot has `filled_size × entry ≤ D5 cash`, and `modelled_cost_charged = 1`, or the exceptions are explained.
- 0c. Confirm both arms trade the same instrument set, as the thesis's falsifier requires. => verify: `select distinct instrument` matches for each arm over one window.

### Step 1 — Settle the fork offline for £0 (admissible now, already sanctioned)

Doc 11's TSMOM strategy **has never been through Stage 2** **[verified: doc 13, "open item 2" in doc 12]**. The harness is ready: 10.2 years of free bars, and MinBTL headroom ≥ 48 even at the one measured Sharpe.

- 1a. Pre-register two configurations before looking at any output: doc 11's monthly TSMOM, and doc 62's weekly variant with its crash-brake rule frozen in writing. Both use the same always-long control at the same vol target, and the UK cost model (Saxo 16 bps round trip at 1×). => verify: the configuration file is committed before the run.
- 1b. Run Stage 2 (PBO, DSR, OOS Sharpe against doc 02's kill line). => verify: a verdict doc with the pass/kill decided by the pre-declared line.
- Kill criterion (declared now): if the weekly variant does not beat always-long at matched vol, either on Sharpe with PBO ≤ 0.05 or on drawdown at equal return, **doc 62's fork is dead** and §5 option B is withdrawn.

### Step 2 — Decide whether the intraday branch is measurable (admissible now)

- 2a. After Step 0, compute the live arm's trade rate and the calendar time needed to reach 231 trades. => verify: a number in the §5 decision note.
- 2b. If that time is more than ~6 months, the intraday thesis cannot be measured at the current cadence. Raising the trade rate means lowering the gate, which is a D4 trial in its own right and would have to be declared as one.

### Step 3 — Cheap hardening from doc 63 (admissible now, off the critical path)

- 3a. Stage input whitelist: each stage declares what it reads, and an undeclared read fails closed (doc 63 mechanism 2). This catches undeclared inputs. **It does not catch this repo's dominant bug class, a tested mechanism that nothing calls.**
- 3b. The check that does catch that class: assert that every declared stage and step actually runs on a smoke tick. => verify: `yarn smoke` fails if any declared stage has zero invocations.
- 3c. Backtest reports show turnover and per-strategy OOS, with net as the headline (doc 63 mechanism 3). => verify: the Step 1 verdict doc shows all three.

### Step 4 — Trials that spend a D4 slot (gated, David's call)

Only run these after Step 0 is fixed and Step 2 shows the intraday branch is measurable:

- The doc 61 sign-gate, with continuation and reversal both pre-registered and N frozen. That is 2 trials.
- The doc 63 N-session decay blend, with N = 3 declared, applied to entries only. That is 1 trial.

If Step 2 says the intraday branch cannot be measured, **do not run either trial**. They would sharpen a book that has no measurement.

## 4. What not to do

- Do not start the Python/event-sourcing chassis rewrite (see §2).
- Do not import Qanat's engine, a vector database, candle patterns, a Medallion clone, or a swing overlay (docs 61 and 63 cover each).
- Do not amend ADR-0014 in place. If the fork is adopted, it gets a new ADR and a wayfinder map (doc 62 §8).
- Do not tune N, the vol target, or the crash-brake threshold on the sample used to decide.

## 5. Decision gate for David (after Steps 0–2)

| Option | Take it if | What it costs |
|---|---|---|
| **A. Stay intraday** (ADR-0014–0018) | Step 0 is clean, **and** Step 2 shows ≤ ~6 months to 231 trades, **and** the live arm is at least not below the control | Live measurement continues; Step 4 trials become eligible |
| **B. Fork to slow TSMOM** (doc 62) | Step 1 passes its declared kill line | New ADR, a wayfinder map, venue and CGT re-score for weekly 1×. Routes around the debate-accuracy problem because rule-based sleeves generate the trades and the LLM is reduced to a veto |
| **C. Stop and hold** | Step 1 fails **and** Step 2 says intraday cannot be measured | Nothing more is spent. The chassis stays as a tested asset for a future thesis |

**My recommendation [inferred]:** do Steps 0 and 1 first, both at £0, and let those results pick the option. My prior leans toward C over B, because doc 11's t = 0.15 is hard to escape at 1×. B is only worth adopting if the weekly variant's crash-brake produces a drawdown advantage that doc 11's monthly version did not.

**David, 2026-09-19:** flat-by-close "was more of a preference, if momentum outweighs day trading i am ok to drop." Option B is open on the evidence alone.

### Multi-sleeve (momentum + day + swing)

David also raised running all three and "use either to maximise profit." The admissible form of that:

1. **Each sleeve passes its own gate first.** Combining sleeves that have no edge adds costs but no return. Today no sleeve is validated: momentum has not been tested (Step 1), the day-trading sleeve cannot be measured yet (Step 2), and swing has no defined signal (doc 61 DOA). The weekly-hold momentum sleeve already covers the swing holding period.
2. **Weights are fixed and declared in advance** (equal-risk, or inverse-vol across sleeves). **Do not route capital to whichever sleeve did best recently.** That is a regime-switching strategy in its own right: it needs its own pre-registration, it counts toward PBO trials, and performance chasing is the selection bias that killed Stage 2 (doc 13).
3. **A combination only helps if the sleeves' returns have low correlation.** Measure correlation before combining, don't assume it.
4. **Book size limits this.** £1,000 across 3 sleeves is about £333 each. Per-position caps and whole-share sizing may leave some sleeves unable to enter at all.
5. **Flat-by-close is set per sleeve.** The day sleeve keeps it; the momentum sleeve holds overnight on 1× ETFs only. The chassis can host both.

## 5a. Deriving live capital from evidence (replaces the £1,000 figure)

David, 2026-09-19: set aside the £1,000 book and derive live capital from evidence.

**Live capital today is £0 [derived].** No sleeve has a validated edge: the live arm stands at 7 trades and −£112, momentum has not been tested, and the scoreboard is broken (§1). Evidence can only size capital for a strategy that has passed its gate.

Once a sleeve passes, capital is bounded by three evidence-based limits and one input only David can supply:

| Limit | Formula | Evidence source |
|---|---|---|
| **Floor** (minimum viable) | `fixed annual cost / expected net annual return`, and also `instruments × max share price`, so whole-share sizing can enter every name | Backtest net return. Fixed costs: LLM ~£58/yr and £7/mo real-time data for the day sleeve. The momentum sleeve is ≈ £0 fixed (no LLM; delayed data is fine at weekly cadence) |
| **Risk ceiling** | `L / (backtest max drawdown × 1.5)` | The backtest's max drawdown. The 1.5× stress factor is **[assumed]**: an in-sample max drawdown understates future drawdowns |
| **Capacity ceiling** | `k × instrument ADV` | Not binding at retail size on liquid 1× ETFs **[inferred]** |
| **L: the £ loss David accepts before stopping** | — | **Not derivable.** It is a statement about David's finances, not about the strategy |

**David, 2026-09-19: L = £1,500.** The risk ceiling is therefore `£1,500 / (backtest max drawdown × 1.5)`. At a 20% drawdown that gives £5,000; at 30% it gives ~£3,333 **[derived]**. **Paper only until David is confident.** Confidence is defined as the pre-declared gate below, not as a feeling.

**Paper trading cannot prove edge; it can only prove fidelity [derived].** A strategy needs about `(1.96 / Sharpe)²` years to separate from zero **[verified: paperswithbacktest README, via doc 64]**. At the realistic Sharpe of 0.4–0.8 that is **6–24 years**. So:

- **Edge evidence comes from the long-history backtest** (Step 1). Haircut its Sharpe by ~40% before it enters any capital formula; that was cross-sectional momentum's in-sample-to-OOS loss **[verified: PWB wiki]**.
- **Paper trading answers a different question:** does live behaviour match the backtest (fills, costs, drawdown path, zero plumbing faults)? Its pass rule is "inside the backtest's band", not "statistically significant on its own".
- **A backtest Sharpe above ~2 gets treated as an artefact** and sent back for a check, not celebrated.

The live ramp is also evidence-gated. Start at the floor, and step capital up only after N live trades whose realized return and drawdown fall inside the backtest's confidence band. A deviation outside the band steps capital back down. Exposure within the capital (leverage, vol target) comes from half-Kelly on a shrunk Sharpe estimate, not from the capital figure.

## 5b. North star and strategic direction (2026-09-19)

### North star (derived; no doc states one)

No document in the repo names a north star **[verified: grep]**. Composed from what is recorded (CONTEXT.md's falsification test, doc 02's graduation line, David's L = £1,500, and his "no live money until confident" rule), it is:

> **A system whose edge over a matched no-LLM control is proven to a pre-declared statistical bar (DSR-significant, PBO ≤ 0.05) on the instruments it will actually trade, then run live at a capital size derived from its measured drawdown and a £1,500 loss limit.**

It is **not a return number.** Doc 10's 0.04%/day is superseded. CONTEXT.md's live Sharpe target of ~1.5 sits above the corpus prior that 0.4–0.8 is a good outcome and anything above 2 is an artefact (doc 64). Treat ~1.5 as aspirational, not as the bar.

### Where Samurai stands against it [verified: `samurai-paper.sqlite`, 2026-09-19]

1. **The debate layer cannot originate a long trade.** 267 debates: 209 neutral (mean confidence 0.133), 42 bearish (mean 0.67), 16 bullish (mean 0.385, **max 0.473**). The conviction floor is **0.55**. **No bullish debate has ever cleared it.** #625 was closed, but its ceiling-below-floor defect persists on the long side.
2. **Paper trading has been running a strategy the live product can't run.** 6 of 7 live-arm trades and 42 of 79 control-arm trades are **shorts** (stop above entry) on US single stocks via Alpaca. The live product is long-only on LSE ETPs through Saxo. The instruments behind the control's profit (MSTR, MARA, COIN, SMCI) are not tradeable at Saxo.
3. **The live universe has 3 instruments** (3LUS, LQQ3, LCO3), and one of them is a 3× single-stock ETP on Coinbase **[verified: doc 60]**.
4. **The scoreboard is inconsistent** (§1: sizing above D5, and the control arm's return has a different sign in the two stores).
5. **The chassis is not the constraint.** 1,428 LLM calls cost **$3.04** in total, so the plumbing is cheap and it works. The ground-up Python rewrite stays withdrawn (§2).
6. **Intraday research is uniformly negative or underpowered:** docs 50 and 57 reject, docs 51 and 55 are underpowered, and doc 13's proxy is a terminal KILL.

**Reading [inferred]:** after ~3.5 weeks of paper trading, nothing in hand counts toward the north star. The debate can't trade long, the arms trade the wrong side and the wrong universe, and the scoreboard disagrees with itself.

### Direction, ordered, each step with a kill criterion

| # | Step | Cost | Kill / decision line (declared now) |
|---|---|---|---|
| D1 | **Long-side conviction audit.** Replay existing `debate_log` offline. Why does bullish confidence cap below 0.5? Is it the scoring formula, the prompts, or the market? | £0, no LLM | If the cap is the formula (e.g. the neutral mass drags the score down), it is a bug: fix it and re-soak. If bullish debates are genuinely rare and weak, **the debate-as-edge thesis is untestable long-only**, so the LLM moves to a veto role (doc 62) |
| D2 | **Make paper match live.** Long-only switch on both arms, universe = the tradeable instruments (or their 1× equivalents under D3), sizing ≤ D5, and fix the scoreboard (§3 Step 0) | small code | Paper results only count after this. Everything earned before it is excluded from any graduation decision |
| D3 | **£0 momentum backtest** (§3 Step 1): monthly and weekly TSMOM, long or flat, 1× ETFs, vs always-long at the same vol, net of Saxo cost, Sharpe haircut 40% | £0 | Kill if it doesn't beat always-long (Sharpe with PBO ≤ 0.05, or drawdown at equal return). If it passes, a new ADR makes momentum sleeve 1 and drops flat-by-close for that sleeve |
| D4 | **Two-sleeve paper soak** (momentum + intraday if D1 survives), with fixed weights and per-sleeve flat-by-close | runtime | Pass = fidelity to the backtest band plus zero plumbing faults (§5a). Not statistical edge, which paper cannot prove |
| D5 | **Live at the floor**, capital ≤ £1,500 / (haircut drawdown × 1.5), only after the rules written in advance under D4 are met **and** David signs off | real money | Step back down on deviation from the backtest band |

**If both D1 and D3 fail, stop.** Keep the chassis as a tested asset and wait for a thesis that clears a gate.

## 6. Knowledge gaps

1. The control-arm sign contradiction (Step 0a) is unexplained.
2. Weekly vs monthly TSMOM against always-long has not been measured on any universe.
3. Saxo's cost at a weekly 1× cadence, and whether an ISA becomes possible again once the strategy is no longer day trading. Doc 62 §9 flags this; it is not re-scored here.
4. Whether the live arm's 7 trades have the same D5 oversizing as the control (only 3 are visibly oversized).

Trial count this doc adds: **0**. Step 1 declares 2 configurations. Step 4 would add 3 if David spends the slots.
