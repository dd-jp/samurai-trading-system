# ADR-0018 — The intraday target: neutral brackets, volatility-constrained sizing, and the bar the signal must clear

- **Status:** Accepted
- **Date:** 2026-08-10
- **Decided by:** David, resolving [#653](https://github.com/dd-jp/samurai-trading-system/issues/653) under map [#631](https://github.com/dd-jp/samurai-trading-system/issues/631)
- **Evidence:** [`docs/research/18-intraday-instrument-physics.md`](../research/18-intraday-instrument-physics.md) Result 4; scripts `18-threshold-study.py`, `18-fetch-bars.py`, `18-fetch-earnings.py`
- **Amends:** [ADR-0016](0016-universe-leveraged-etps-ungated.md) (expectancy figures), `CONTEXT.md` drawdown target
- **Builds on:** [ADR-0014](0014-intraday-flat-by-close-horizon.md), [ADR-0015](0015-live-venue-account-and-book-split.md)

## Context

[ADR-0014](0014-intraday-flat-by-close-horizon.md) moved the product to an intraday horizon and superseded doc 10's target (0.04%/day, −23% pre-accepted drawdown). That left the system with **no return target and no drawdown commitment**. #653 was opened to derive both from history rather than from a desired number — satisfying doc 10 line 53's forbid on *"any return target set from desire rather than measurement."*

The measurement is over **10.6 years**, 2016-01-04 → 2026-07-31, Alpaca SIP: SPY 5-minute and TSLA 1-minute (1.92M bars), regular hours, underlying tape scaled by the ETP leverage factor.

## Decision 1 — the target is an **expectancy**, never a return number

```
E = P_win × Avg_win − P_loss × Avg_loss − Costs
```

`CONTEXT.md` already names expectancy as the north star, it is the form the validation gates consume, and a headline return number is exactly what doc 10 forbids. **No annualised percentage is a commitment of this system.**

## Decision 2 — thresholds are **pooled per asset-class subclass**, fitted to the **all-day** distribution

Not per-instrument, and **not event-conditioned**. The universe is scanned daily ([#635](https://github.com/dd-jp/samurai-trading-system/issues/635)), so there is no fixed instrument list to fit per-instrument studies to.

Event conditioning was tested directly rather than assumed away. Earnings-reaction sessions for TSLA, 46 across 10.6 years:

| strategy | expectancy/trade | n | t |
| --- | --- | --- | --- |
| pooled grid, every session | −0.4257% | 897 | −3.10 |
| earnings-reaction sessions only | **−1.3267%** | 18 | −4.19 |
| combination — event levels on event days | −0.4282% | 897 | −3.12 |

**Event days are 0.92%/trade worse, t = −2.66**, and remain negative gross of cost with stops widened to −6%. An earnings reaction raises volatility without supplying direction, so a fixed stop is reached sooner while the take-profit is not.

**And events are 1.73% of sessions**, so event-conditioned levels cannot move the blended result whatever their sign. This is a structural argument, not a statistical one, and it does not weaken with more data.

## Decision 3 — the levels are the **neutral bracket**

**The rule, declared before fitting:** the bracket in which take-profit and stop are **equally likely to be hit first**, unconditionally. At that bracket the position is a fair coin, so the entry signal's only job is directional accuracy, and the edge it must supply is exactly the round-trip cost amortised over the bracket width.

| subclass | round trip | **take-profit** | **stop** | resolves at a level | accuracy edge required |
| --- | --- | --- | --- | --- | --- |
| **3× index ETP / ETC** | 0.18% | **+2.00%** | **−2.16%** | 48.8% | **+4.33 pp** |
| **3× single-stock ETP** | 0.41% | **+6.00%** | **−6.25%** | 71.6% | **+3.35 pp** |

In underlying terms: **+0.67% / −0.72%** on the index and **+2.00% / −2.08%** on the single name — ordinary intraday moves, which is the sanity check that matters.

**Why the single-stock bracket is wider despite higher volatility:** its cost is 2.3× larger, and cost is amortised over bracket width. Narrow brackets make the ladder fire often but demand a large edge (+8.9 pp at +1.0%); wide brackets need almost none but rarely fire, degenerating into hold-to-close (90.4% close-outs at +4.5%). These two sit at the widest point that still resolves a meaningful share of trades.

Both require **less** accuracy than the ~55% win rate (+5 pp) [ADR-0017](0017-validation-gates-paper-operational-thesis-expectancy.md) already assumes, so they carry margin against the project's own claim.

**Corollary that corrects ADR-0016's intuition:** it is **not leverage** that improves the economics — it is **bracket width relative to a fixed cost**. Leverage helps only by making a wide ETP-percentage bracket reachable within one session, and it raises the spread at the same time.

## Decision 4 — selection budget: **three configurations, selected once**

One pooled pair per subclass (index ETP, single-stock ETP, crypto). The levels follow from the declared neutral-bracket rule rather than from a search, so nothing is selected on and PBO has no set of alternatives to compute over. Doc 13's chain — PBO 0.85 against a 0.05 line, 3 of 24 surviving out-of-sample — is what this avoids.

**Re-selection versus re-calibration.** Re-running a grid and picking a new winner costs trials and happens **once**. Re-computing the *same declared rule* on a rolling window costs nothing, because no choice is made. **The frozen artefact is the rule, not the percentages** — freezing "+2.00%" and revisiting it later is re-selection under another name.

## Decision 5 — drawdown is a **sizing constraint**, not a target

Measured on a **drift-removed** series, so this is the pure volatility envelope with zero edge assumed:

| subclass | per-trade sd | annualised vol | max drawdown at full £750 |
| --- | --- | --- | --- |
| 3× index ETP | 1.55% | 24.6% | **55.6%** |
| 3× single-stock ETP | 4.01% | 63.6% | **88.0%** |

`CONTEXT.md`'s recorded tolerance is **max ~20–25%**. Full deployment of the equity leg sits **2.2× to 3.5× outside it before any edge exists**, so the constraint binds regardless of how good the signal turns out to be.

**Now:** deploy a fixed fraction sized per subclass by measured volatility — **~35% of the leg (~£260) for index ETPs, ~25% (~£190) for single-stock ETPs**, holding max drawdown at **23.1%** and **26.2%** respectively (doc 18 Result 4's **"The volatility envelope, and why it fixes position size"** table).

**The single-stock fraction deliberately overshoots the tolerance.** 26.2% is **~1.2 pp above the top of `CONTEXT.md`'s ~20–25% band**; the index fraction sits inside it. The overshoot is accepted rather than sized away because the single-stock subclass is the one whose bracket the cost argument depends on, and because the envelope is measured **drift-removed with zero edge assumed** — a deliberately pessimistic reading. It is recorded here rather than rounded off so that whatever consumes this number for sizing consumes the overshoot with it. If the tolerance is to bind strictly on this subclass, the fraction has to fall to roughly **~24%**, which no measured row in doc 18's table covers — re-measure before adopting it.

**Target state:** volatility-targeted per-trade sizing, so each position contributes equal risk rather than equal cash. It is what the 20–25% number means operationally and what [#654](https://github.com/dd-jp/samurai-trading-system/issues/654)'s ladder will need. The Risk Manager has no such rule today.

## Consequences

**The study's output is a bar, not a profit estimate.** At the neutral bracket the required edge is the cost itself: **+0.18%/trade for index ETPs, +0.41% for single-stock ETPs**, or equivalently **+4.33 and +3.35 percentage points of directional accuracy** over a coin flip. This is the first falsifiable statement of what the debate layer has to be worth.

**[#625](https://github.com/dd-jp/samurai-trading-system/issues/625) becomes the critical path.** A system that has produced 96 debates and 0 trades has never been measured against this bar, and nothing downstream of it can be.

**ADR-0015's £750/£750 split now means allocated, not deployed, capital** on the equity side. The split itself is unchanged.

**The crypto brackets are not set by this ADR.** #660's 4%/2% levels are unmeasured. The same engine applies — crypto 1-minute is free from 2021-01-04 per doc 33 — but "session" is undefined for crypto until [#667](https://github.com/dd-jp/samurai-trading-system/issues/667) fixes the flatten rule, so the measurement is blocked, not skipped.

## Known weaknesses

**The baseline is an unconditional long at the open.** That is deliberately naive — it is the bar, not a prediction that the strategy loses money. It is also **long-only**; the short ETP lines are unmeasured.

**Underlying tape, not ETP tape.** No tracking error, no ETP spread beyond the assumed round trip, and **no GBP/USD leg** — the GBP lines sit on USD underlyings and hedging is unconfirmed. [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) owns the real spreads per subclass; **both brackets and both bars move directly with them**, since each cost figure is currently a single quote.

**Two instruments, not the universe.** SPY and TSLA stand in for their subclasses.
